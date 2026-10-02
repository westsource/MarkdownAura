fn main() {
    tauri_build::build();

    // tauri-build hands the Windows resource to the linker with `cargo:rustc-link-arg-bins`,
    // which — as the name says — covers binaries and not test targets. A test build therefore
    // links without the embedded manifest, Windows falls back to Common-Controls v5, the
    // `TaskDialogIndirect` import that tauri carries cannot be resolved, and the harness dies
    // with STATUS_ENTRYPOINT_NOT_FOUND before a single test runs. It looks like a broken
    // toolchain; it is a missing link argument.
    //
    // `rustc-link-arg` rather than `rustc-link-arg-tests`: cargo rejects the latter outright when
    // the package has no integration test target ("does not have a test target"), which is the
    // case here — the tests live in `#[cfg(test)]` modules.
    //
    // The cost of the unqualified form is that a binary now names the archive twice, and GNU ld
    // reports it:
    //
    //     ld: .rsrc merge failure: multiple non-default manifests
    //     ld: .rsrc merge failure: duplicate leaf: type: 3 (ICON) name: 1 lang: 409
    //
    // That is a warning, not an error, and it is the price of tests being able to run at all:
    // cargo cannot express "test targets but not binaries". It is not silently wrong either —
    // the right manifest wins, which is why the harness starts (it can only do that with
    // Common-Controls v6 active). Remove this once tauri-build covers test targets itself.
    if let Ok(out_dir) = std::env::var("OUT_DIR") {
        let resource = std::path::Path::new(&out_dir).join("libresource.a");
        if resource.exists() {
            println!("cargo:rustc-link-arg={}", resource.display());
        }
    }
}
