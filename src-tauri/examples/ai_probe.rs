// Exercise the same local-only caption command used by the desktop interface.
#[path = "../src/ai.rs"]
mod ai;
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let file = args.get(1).expect("Usage: ai_probe INPUT.json [model]");
    let nodes = serde_json::from_str(&std::fs::read_to_string(file).expect("read input")).expect("caption inputs");
    let model = args.get(2).cloned().unwrap_or_else(|| "qwen2.5:0.5b".into());
    match tauri::async_runtime::block_on(ai::ai_captions(model, nodes)) {
        Ok(captions) => println!("{}", serde_json::to_string_pretty(&captions).unwrap()),
        Err(error) => { eprintln!("{error}"); std::process::exit(1); }
    }
}
