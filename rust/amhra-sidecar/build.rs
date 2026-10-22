//! With the `shared-onnxruntime` feature, sherpa-onnx is linked as shared libraries, which
//! its build script copies next to the binaries in `target/<profile>/`. Its
//! search path does not carry over to the binaries that depend on it, so they
//! are told here where to look: beside themselves, and one level up for the
//! examples.

fn main() {
	println!("cargo:rerun-if-changed=build.rs");
	let shared = std::env::var_os("CARGO_FEATURE_SHARED_ONNXRUNTIME").is_some();
	let macos = std::env::var("CARGO_CFG_TARGET_OS").is_ok_and(|os| os == "macos");
	if shared && macos {
		println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path");
		println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path/..");
	}
}
