//! Bakes the PocketBase executable named by `NYX_PB_BIN` into the server. Without it
//! the embedded copy is empty, and the server needs an external PocketBase.

use std::{env, fs, path::Path};

fn main() {
    println!("cargo:rerun-if-env-changed=NYX_PB_BIN");
    let out = Path::new(&env::var("OUT_DIR").unwrap()).join("pocketbase");
    match env::var("NYX_PB_BIN") {
        Ok(bin) => {
            println!("cargo:rerun-if-changed={bin}");
            fs::copy(&bin, out).unwrap_or_else(|e| panic!("NYX_PB_BIN {bin}: {e}"));
        }
        Err(_) => fs::write(out, []).unwrap(),
    }
}
