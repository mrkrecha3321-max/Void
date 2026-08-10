// Most JNI: callbacki wywolywane z Kotlina (BleManager.kt, NfcManager.kt -> NativeBridge.kt)
// oraz przechowanie AppHandle, zeby moc emitowac zdarzenia Tauri z watku JNI.

use once_cell::sync::OnceCell;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

pub static APP_HANDLE: OnceCell<Mutex<Option<AppHandle>>> = OnceCell::new();

/// Globalny ClassLoader apki — potrzebny żeby JNI na wątkach roboczych
/// mogło znajdować klasy com.vortex.mesh.* (które nie są w systemowym loaderze).
#[cfg(target_os = "android")]
pub static CLASS_LOADER: OnceCell<Mutex<Option<jni::objects::GlobalRef>>> = OnceCell::new();

#[cfg(target_os = "android")]
pub static ANDROID_CONTEXT: OnceCell<Mutex<Option<jni::objects::GlobalRef>>> = OnceCell::new();

pub fn set_app_handle(app: AppHandle) {
    let cell = APP_HANDLE.get_or_init(|| Mutex::new(None));
    *cell.lock().unwrap_or_else(|e| e.into_inner()) = Some(app);
}

#[allow(dead_code)]
fn emit(event: &str, payload: serde_json::Value) {
    if let Some(cell) = APP_HANDLE.get() {
        if let Ok(guard) = cell.lock() {
            if let Some(app) = guard.as_ref() {
                let _ = app.emit(event, payload);
            }
        }
    }
}

#[cfg(target_os = "android")]
mod android {
    use super::emit;
    use jni::objects::{JObject, JString};
    use jni::sys::jint;
    use jni::JNIEnv;
    use tauri::Manager;

    fn jstr(env: &mut JNIEnv, s: &JString) -> String {
        env.get_string(s).map(|v| v.into()).unwrap_or_default()
    }

    #[no_mangle]
    pub extern "system" fn Java_com_vortex_mesh_NativeBridge_onPeerDiscovered(
        mut env: JNIEnv,
        _this: JObject,
        address: JString,
        short_id: JString,
        name: JString,
        rssi: jint,
    ) {
        let address = jstr(&mut env, &address);
        let short_id = jstr(&mut env, &short_id);
        let name = jstr(&mut env, &name);

        // Record the peer's BLE address so we can find it later by short_id
        if let Some(cell) = super::APP_HANDLE.get() {
            if let Ok(guard) = cell.lock() {
                if let Some(app) = guard.as_ref() {
                    let state = app.state::<crate::mesh::MeshState>();
                    state.record_discovered_peer(&address, &short_id, &name, rssi);
                    // NOTE: DO NOT call send_presence here — GATT is not yet established
                    // send_presence is called in onPeerConnected after connectGatt succeeds
                }
            }
        }

        emit(
            "ble_peer_discovered",
            serde_json::json!({ "address": address, "shortId": short_id, "name": name, "rssi": rssi }),
        );
    }

    #[no_mangle]
    pub extern "system" fn Java_com_vortex_mesh_NativeBridge_onPeerConnected(
        mut env: JNIEnv,
        _this: JObject,
        address: JString,
    ) {
        let address = jstr(&mut env, &address);
        if let Some(cell) = super::APP_HANDLE.get() {
            if let Some(app) = cell.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
                let state = app.state::<crate::mesh::MeshState>();
                state.mark_connected(&address);
                crate::mesh::send_presence(&state, &address);
            }
        }
        emit("ble_peer_connected", serde_json::json!({ "address": address }));
    }

    #[no_mangle]
    pub extern "system" fn Java_com_vortex_mesh_NativeBridge_onPeerDisconnected(
        mut env: JNIEnv,
        _this: JObject,
        address: JString,
    ) {
        let address = jstr(&mut env, &address);
        if let Some(cell) = super::APP_HANDLE.get() {
            if let Some(app) = cell.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
                let state = app.state::<crate::mesh::MeshState>();
                state.mark_disconnected(&address);
            }
        }
        emit("ble_peer_disconnected", serde_json::json!({ "address": address }));
    }

    #[no_mangle]
    pub extern "system" fn Java_com_vortex_mesh_NativeBridge_onMessageReceived(
        mut env: JNIEnv,
        _this: JObject,
        address: JString,
        text: JString,
    ) {
        let address = jstr(&mut env, &address);
        let text = jstr(&mut env, &text);
        if let Some(cell) = super::APP_HANDLE.get() {
            if let Some(app) = cell.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
                let state = app.state::<crate::mesh::MeshState>();
                crate::mesh::handle_incoming(app, &state, &address, &text);
            }
        }
    }

    #[no_mangle]
    pub extern "system" fn Java_com_vortex_mesh_NativeBridge_onBleError(
        mut env: JNIEnv,
        _this: JObject,
        message: JString,
    ) {
        let message = jstr(&mut env, &message);
        emit("ble_error", serde_json::json!({ "message": message }));
    }

    #[no_mangle]
    pub extern "system" fn Java_com_vortex_mesh_NativeBridge_onNfcTagRead(
        mut env: JNIEnv,
        _this: JObject,
        payload: JString,
    ) {
        let payload = jstr(&mut env, &payload);
        emit("nfc_tag_read", serde_json::json!({ "payload": payload }));
    }

    #[no_mangle]
    pub extern "system" fn Java_com_vortex_mesh_NativeBridge_onNfcError(
        mut env: JNIEnv,
        _this: JObject,
        message: JString,
    ) {
        let message = jstr(&mut env, &message);
        emit("nfc_error", serde_json::json!({ "message": message }));
    }

    #[no_mangle]
    pub extern "system" fn Java_com_vortex_mesh_NativeBridge_onPermissionsGranted(
        _env: JNIEnv,
        _this: JObject,
    ) {
        emit("ble_permissions_granted", serde_json::json!({ "granted": true }));
    }
    static CONTEXT_INITIALIZED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

    #[no_mangle]
    pub extern "system" fn Java_com_vortex_mesh_NativeBridge_setAndroidContext(
        env: JNIEnv,
        _this: JObject,
        context: JObject,
    ) {
        use std::sync::Mutex;
        match env.new_global_ref(&context) {
            Ok(global) => {
                let cell = super::ANDROID_CONTEXT.get_or_init(|| Mutex::new(None));
                *cell.lock().unwrap_or_else(|e| e.into_inner()) = Some(global);
            }
            Err(e) => {
                eprintln!("NativeBridge: setAndroidContext GlobalRef failed: {:?}", e);
            }
        }

        if !CONTEXT_INITIALIZED.swap(true, std::sync::atomic::Ordering::SeqCst) {
            if let Ok(vm) = env.get_java_vm() {
                let vm_ptr = vm.get_java_vm_pointer() as *mut std::ffi::c_void;
                let context_ptr = context.into_raw() as *mut std::ffi::c_void;
                unsafe {
                    ndk_context::initialize_android_context(vm_ptr, context_ptr);
                }
            }
        }
    }

    #[no_mangle]
    pub extern "system" fn Java_com_vortex_mesh_NativeBridge_setClassLoader(
        mut env: JNIEnv,
        _this: JObject,
        class_loader: JObject,
    ) {
        use std::sync::Mutex;
        match env.new_global_ref(&class_loader) {
            Ok(global) => {
                let cell = super::CLASS_LOADER.get_or_init(|| Mutex::new(None));
                *cell.lock().unwrap_or_else(|e| e.into_inner()) = Some(global);
            }
            Err(e) => {
                eprintln!("NativeBridge: setClassLoader failed: {:?}", e);
            }
        }
    }
}

// ---- Rust -> Kotlin: wywolania na BleManager (JVM static, dzieki @JvmStatic) ----
#[cfg(target_os = "android")]
pub mod calls {
    use jni::objects::{JClass, JObject, JValue};
    use jni::JNIEnv;
    use jni::JavaVM;

    /// Ładuje klasę przez ClassLoader apki (działa na wątkach roboczych).
    /// Bez tego JNI rzuca ClassNotFoundException na Thread-N bo
    /// domyślny loader nie zna klas com.vortex.mesh.*
    fn find_app_class<'a>(env: &mut JNIEnv<'a>, class_name: &str) -> Result<JClass<'a>, String> {
        let cell = super::CLASS_LOADER
            .get()
            .ok_or("ClassLoader not set — setClassLoader() was not called yet".to_string())?;
        let guard = cell.lock().unwrap_or_else(|e| e.into_inner());
        let loader_ref = guard
            .as_ref()
            .ok_or("ClassLoader GlobalRef is None".to_string())?;
        // Konwertuj slash-notation na dot-notation: com/vortex/mesh/BleManager -> com.vortex.mesh.BleManager
        let dot_name = class_name.replace('/', ".");
        let class_name_j = env.new_string(&dot_name).map_err(|e| e.to_string())?;
        let result = env
            .call_method(
                loader_ref,
                "loadClass",
                "(Ljava/lang/String;)Ljava/lang/Class;",
                &[JValue::Object(&class_name_j.into())],
            )
            .map_err(|e| format!("loadClass({dot_name}) failed: {e}"))?;
        Ok(JClass::from(result.l().map_err(|e| e.to_string())?))
    }

    pub fn init(node_id: &str, name: &str) -> Result<(), String> {
        let android_ctx = ndk_context::android_context();
        let vm = unsafe { JavaVM::from_raw(android_ctx.vm().cast()) }.map_err(|e| e.to_string())?;
        let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
        let ctx_cell = super::ANDROID_CONTEXT.get().ok_or("ANDROID_CONTEXT not set")?;
        let ctx_guard = ctx_cell.lock().unwrap_or_else(|e| e.into_inner());
        let ctx_ref = ctx_guard.as_ref().ok_or("ANDROID_CONTEXT GlobalRef is None")?;
        let ctx = ctx_ref.as_obj();
        let node_id_j = env.new_string(node_id).map_err(|e| e.to_string())?;
        let name_j = env.new_string(name).map_err(|e| e.to_string())?;
        let class = find_app_class(&mut env, "com/vortex/mesh/BleManager")?;
        env.call_static_method(
            class,
            "init",
            "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)V",
            &[JValue::Object(ctx), JValue::Object(&node_id_j.into()), JValue::Object(&name_j.into())],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn start_advertising() -> Result<bool, String> {
        let android_ctx = ndk_context::android_context();
        let vm = unsafe { JavaVM::from_raw(android_ctx.vm().cast()) }.map_err(|e| e.to_string())?;
        let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
        let ctx_cell = super::ANDROID_CONTEXT.get().ok_or("ANDROID_CONTEXT not set")?;
        let ctx_guard = ctx_cell.lock().unwrap_or_else(|e| e.into_inner());
        let ctx_ref = ctx_guard.as_ref().ok_or("ANDROID_CONTEXT GlobalRef is None")?;
        let ctx = ctx_ref.as_obj();
        let class = find_app_class(&mut env, "com/vortex/mesh/BleManager")?;
        let res = env
            .call_static_method(
                class,
                "startAdvertising",
                "(Landroid/content/Context;)Z",
                &[JValue::Object(ctx)],
            )
            .map_err(|e| e.to_string())?;
        res.z().map_err(|e| e.to_string())
    }

    pub fn start_scanning() -> Result<bool, String> {
        let android_ctx = ndk_context::android_context();
        let vm = unsafe { JavaVM::from_raw(android_ctx.vm().cast()) }.map_err(|e| e.to_string())?;
        let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
        let ctx_cell = super::ANDROID_CONTEXT.get().ok_or("ANDROID_CONTEXT not set")?;
        let ctx_guard = ctx_cell.lock().unwrap_or_else(|e| e.into_inner());
        let ctx_ref = ctx_guard.as_ref().ok_or("ANDROID_CONTEXT GlobalRef is None")?;
        let ctx = ctx_ref.as_obj();
        let class = find_app_class(&mut env, "com/vortex/mesh/BleManager")?;
        let res = env
            .call_static_method(
                class,
                "startScanning",
                "(Landroid/content/Context;)Z",
                &[JValue::Object(ctx)],
            )
            .map_err(|e| e.to_string())?;
        res.z().map_err(|e| e.to_string())
    }

    pub fn stop_scanning() -> Result<(), String> {
        let android_ctx = ndk_context::android_context();
        let vm = unsafe { JavaVM::from_raw(android_ctx.vm().cast()) }.map_err(|e| e.to_string())?;
        let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
        let ctx_cell = super::ANDROID_CONTEXT.get().ok_or("ANDROID_CONTEXT not set")?;
        let ctx_guard = ctx_cell.lock().unwrap_or_else(|e| e.into_inner());
        let ctx_ref = ctx_guard.as_ref().ok_or("ANDROID_CONTEXT GlobalRef is None")?;
        let ctx = ctx_ref.as_obj();
        let class = find_app_class(&mut env, "com/vortex/mesh/BleManager")?;
        env.call_static_method(
            class,
            "stopScanning",
            "(Landroid/content/Context;)V",
            &[JValue::Object(ctx)],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn send_message(address: &str, text: &str) -> Result<bool, String> {
        let android_ctx = ndk_context::android_context();
        let vm = unsafe { JavaVM::from_raw(android_ctx.vm().cast()) }.map_err(|e| e.to_string())?;
        let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
        let ctx_cell = super::ANDROID_CONTEXT.get().ok_or("ANDROID_CONTEXT not set")?;
        let ctx_guard = ctx_cell.lock().unwrap_or_else(|e| e.into_inner());
        let ctx_ref = ctx_guard.as_ref().ok_or("ANDROID_CONTEXT GlobalRef is None")?;
        let ctx = ctx_ref.as_obj();
        let address_j = env.new_string(address).map_err(|e| e.to_string())?;
        let text_j = env.new_string(text).map_err(|e| e.to_string())?;
        let class = find_app_class(&mut env, "com/vortex/mesh/BleManager")?;
        let res = env
            .call_static_method(
                class,
                "sendMessage",
                "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)Z",
                &[JValue::Object(ctx), JValue::Object(&address_j.into()), JValue::Object(&text_j.into())],
            )
            .map_err(|e| e.to_string())?;
        res.z().map_err(|e| e.to_string())
    }

    pub fn connect_to_peer(address: &str) -> Result<bool, String> {
        let android_ctx = ndk_context::android_context();
        let vm = unsafe { JavaVM::from_raw(android_ctx.vm().cast()) }.map_err(|e| e.to_string())?;
        let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
        let ctx_cell = super::ANDROID_CONTEXT.get().ok_or("ANDROID_CONTEXT not set")?;
        let ctx_guard = ctx_cell.lock().unwrap_or_else(|e| e.into_inner());
        let ctx_ref = ctx_guard.as_ref().ok_or("ANDROID_CONTEXT GlobalRef is None")?;
        let ctx = ctx_ref.as_obj();
        let address_j = env.new_string(address).map_err(|e| e.to_string())?;
        let class = find_app_class(&mut env, "com/vortex/mesh/BleManager")?;
        let res = env
            .call_static_method(
                class,
                "connectToPeer",
                "(Landroid/content/Context;Ljava/lang/String;)Z",
                &[JValue::Object(ctx), JValue::Object(&address_j.into())],
            )
            .map_err(|e| e.to_string())?;
        res.z().map_err(|e| e.to_string())
    }
}

#[cfg(not(target_os = "android"))]
pub mod calls {
    pub fn init(_node_id: &str, _name: &str) -> Result<(), String> {
        Err("BLE dostepne tylko na Androidzie".into())
    }
    pub fn start_advertising() -> Result<bool, String> {
        Err("BLE dostepne tylko na Androidzie".into())
    }
    pub fn start_scanning() -> Result<bool, String> {
        Err("BLE dostepne tylko na Androidzie".into())
    }
    pub fn stop_scanning() -> Result<(), String> {
        Err("BLE dostepne tylko na Androidzie".into())
    }
    pub fn send_message(_address: &str, _text: &str) -> Result<bool, String> {
        Err("BLE dostepne tylko na Androidzie".into())
    }
    pub fn connect_to_peer(_address: &str) -> Result<bool, String> {
        Err("BLE dostepne tylko na Androidzie".into())
    }
}
