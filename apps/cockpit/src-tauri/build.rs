// tauri-build generates the context that `tauri::generate_context!()` expands,
// reading tauri.conf.json and the icons. It is a build dependency, so Cargo
// only runs it if this file exists — without it the macro has nothing to
// expand and the crate does not compile.
fn main() {
    tauri_build::build()
}
