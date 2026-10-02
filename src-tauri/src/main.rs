// Keep the console in debug builds so panics and printouts are visible during development,
// and hide it in release where a console window would be a bug.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    markdownaura_lib::run()
}
