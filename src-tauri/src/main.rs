// Keep Windows release builds console-free.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    vortex_app_lib::run()
}
