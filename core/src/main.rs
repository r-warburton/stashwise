use serde_json::json;
use std::io::{self, Read};

fn main() {
    let mut input = String::new();
    let result = io::stdin()
        .take(24 * 1024 * 1024)
        .read_to_string(&mut input)
        .map_err(|e| e.to_string())
        .and_then(|_| serde_json::from_str(&input).map_err(|e| e.to_string()))
        .and_then(stashwise_core::run);
    match result {
        Ok(value) => println!("{value}"),
        Err(message) => {
            println!("{}", json!({"error":message}));
            std::process::exit(1);
        }
    }
}
