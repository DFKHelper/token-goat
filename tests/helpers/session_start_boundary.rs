//! Standalone Windows process fixture: no libuv job can mask missing containment.
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // Stand-in for the startup owner at its emergency stop: it reads the payload to the end, then ends with the code the real owner's deadline thread uses.
    if args[0] == "--session-start-owner-v1" {
        let _ = std::io::copy(&mut std::io::stdin(), &mut std::io::sink());
        std::process::exit(124);
    }
    if args[0] == "hold" {
        std::fs::write(&args[1], std::process::id().to_string()).unwrap();
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    }
    let result = Command::new(std::env::current_exe().unwrap())
        .args(["hold", &args[1]])
        .creation_flags(0x01000000) // CREATE_BREAKAWAY_FROM_JOB
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn();
    match result {
        Ok(child) => {
            std::fs::write(&args[2], format!("created:{}", child.id())).unwrap();
        }
        Err(error) => {
            std::fs::write(
                &args[2],
                format!("denied:{}", error.raw_os_error().unwrap()),
            )
            .unwrap();
        }
    }
    if args[0] == "direct-breakaway" {
        println!("{{}}");
    }
}
