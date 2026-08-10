#[cfg(target_os = "android")]
use tauri::AppHandle;

#[cfg(target_os = "android")]
pub fn install_apk_jni(_app: &AppHandle, apk_path: String) -> Result<(), String> {
    use jni::JavaVM;
    use jni::objects::JValue;
    
    let ctx = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| e.to_string())?;
    let mut env = vm.attach_current_thread().map_err(|e| e.to_string())?;
    
    let class_name = "com/vortex/mesh/MainActivity";
    let apk_path_jstring = env.new_string(apk_path).map_err(|e| e.to_string())?;
    let apk_path_jobject: jni::objects::JObject = apk_path_jstring.into();
    
    env.call_static_method(
        class_name,
        "installApk",
        "(Ljava/lang/String;)V",
        &[JValue::Object(&apk_path_jobject)],
    ).map_err(|e| format!("JNI call failed: {}", e))?;
    
    Ok(())
}

#[cfg(not(target_os = "android"))]
pub fn install_apk_jni(_app: &tauri::AppHandle, _apk_path: String) -> Result<(), String> {
    Err("APK Installation is only supported on Android.".into())
}
