//! Standalone Windows process fixture: no libuv job can mask missing containment.
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};

#[repr(C)]
struct DebugEvent {
    code: u32,
    process: u32,
    thread: u32,
    info: [u64; 20],
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn DebugActiveProcess(pid: u32) -> i32;
    fn WaitForDebugEvent(event: *mut DebugEvent, milliseconds: u32) -> i32;
    fn ContinueDebugEvent(pid: u32, tid: u32, status: u32) -> i32;
    fn CloseHandle(handle: u64) -> i32;
}

/// Attach as a debugger and hold the target's exit for `hold_ms` once it is
/// terminated: Windows has set the exit code by then, but the process keeps its
/// handles, working directory and mapped image until the debugger continues.
fn debug_exit(pid: u32, marker: &str, hold_ms: u64) {
    assert!(unsafe { DebugActiveProcess(pid) } != 0, "attach failed");
    let mut event = DebugEvent { code: 0, process: 0, thread: 0, info: [0; 20] };
    let mut attached = false;
    loop {
        assert!(unsafe { WaitForDebugEvent(&mut event, u32::MAX) } != 0);
        let mut status = 0x0001_0002; // DBG_CONTINUE
        match event.code {
            // CREATE_PROCESS and LOAD_DLL hand over a handle to the image or DLL
            // file; keeping it would hold that file open on the debugger's behalf.
            3 | 6 if event.info[0] != 0 => {
                unsafe { CloseHandle(event.info[0]) };
            }
            1 if attached => status = 0x8001_0001, // DBG_EXCEPTION_NOT_HANDLED
            1 => {
                attached = true;
                std::fs::write(marker, "attached").unwrap();
            }
            5 => {
                std::fs::write(marker, "exiting").unwrap();
                std::thread::sleep(std::time::Duration::from_millis(hold_ms));
                unsafe { ContinueDebugEvent(event.process, event.thread, status) };
                return;
            }
            _ => {}
        }
        unsafe { ContinueDebugEvent(event.process, event.thread, status) };
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args[0] == "debug-exit" {
        debug_exit(args[1].parse().unwrap(), &args[2], args[3].parse().unwrap());
        return;
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
