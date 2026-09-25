//! One connection to a hook server endpoint, with a deadline on every step: a named pipe on Windows, a Unix socket elsewhere, as `net.connect(endpointFor(...))` reaches in src/hook_client.ts. std gives neither a named-pipe client nor a pipe read that can time out, so the Windows side opens the pipe overlapped and abandons any read or write still pending at its deadline.

use std::time::Instant;

/// Why no connection was made. `Absent` is the ENOENT/ECONNREFUSED of `attempt` (nobody listening); `Busy` is a pipe whose every instance is taken for longer than the deadline allows, which only a named pipe can be; anything else is `Other`, which `attempt` reports as refused.
#[derive(Debug, PartialEq, Eq)]
pub enum ConnectError {
    Absent,
    #[cfg(windows)]
    Busy,
    Other,
}

/// Why a read or write stopped short.
#[derive(Debug, PartialEq, Eq)]
pub enum IoError {
    Timeout,
    Closed,
}

#[cfg(windows)]
mod imp {
    use std::ptr::{null, null_mut};
    use std::time::Instant;

    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_FILE_NOT_FOUND, ERROR_IO_PENDING, ERROR_PATH_NOT_FOUND, ERROR_PIPE_BUSY, GENERIC_READ, GENERIC_WRITE, GetLastError, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, FILE_FLAG_OVERLAPPED, OPEN_EXISTING, ReadFile, SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT, WriteFile};
    use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
    use windows_sys::Win32::System::Pipes::WaitNamedPipeW;
    use windows_sys::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

    use super::{ConnectError, IoError};

    pub struct Conn {
        pipe: HANDLE,
        event: HANDLE,
    }

    impl Drop for Conn {
        fn drop(&mut self) {
            // SAFETY: both handles were opened by `connect` and are closed exactly once, here.
            unsafe {
                CloseHandle(self.pipe);
                CloseHandle(self.event);
            }
        }
    }

    /// Milliseconds left before `deadline`, below INFINITE so a wait always ends.
    fn ms_until(deadline: Instant) -> u32 {
        deadline.saturating_duration_since(Instant::now()).as_millis().min(u128::from(u32::MAX - 1)) as u32
    }

    impl Conn {
        pub fn connect(endpoint: &str, deadline: Instant) -> Result<Conn, ConnectError> {
            let name: Vec<u16> = endpoint.encode_utf16().chain(Some(0)).collect();
            loop {
                // SECURITY_IDENTIFICATION: whoever holds the pipe name may learn who connected, never act as them. std's File::open asks for the same.
                // SAFETY: `name` is NUL-terminated and outlives the call; every other argument is a constant or null where the API allows it.
                let pipe =
                    unsafe { CreateFileW(name.as_ptr(), GENERIC_READ | GENERIC_WRITE, 0, null(), OPEN_EXISTING, FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, null_mut()) };
                if pipe != INVALID_HANDLE_VALUE {
                    // A manual-reset event: ReadFile and WriteFile reset it as each operation starts.
                    // SAFETY: no attributes and no name; a null return is checked.
                    let event = unsafe { CreateEventW(null(), 1, 0, null()) };
                    if event.is_null() {
                        // SAFETY: `pipe` was just opened and is not used again.
                        unsafe { CloseHandle(pipe) };
                        return Err(ConnectError::Other);
                    }
                    return Ok(Conn { pipe, event });
                }
                // SAFETY: reads this thread's last-error value.
                match unsafe { GetLastError() } {
                    ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => return Err(ConnectError::Absent),
                    ERROR_PIPE_BUSY => {
                        // Every instance the server created is mid-accept. A timeout of 0 would mean the pipe's default wait, so an expired deadline stops here instead.
                        let ms = ms_until(deadline);
                        // SAFETY: `name` is NUL-terminated.
                        if ms == 0 || unsafe { WaitNamedPipeW(name.as_ptr(), ms) } == 0 {
                            return Err(ConnectError::Busy);
                        }
                    }
                    _ => return Err(ConnectError::Other),
                }
            }
        }

        /// Starts one overlapped transfer with `start` and waits for it until `deadline`. A transfer still pending then is cancelled; one that completed in the meantime still counts.
        fn transfer(&mut self, deadline: Instant, start: impl FnOnce(HANDLE, *mut OVERLAPPED) -> i32) -> Result<usize, IoError> {
            let mut ov = OVERLAPPED { hEvent: self.event, ..Default::default() };
            if start(self.pipe, &mut ov) == 0 {
                // SAFETY: reads this thread's last-error value.
                if unsafe { GetLastError() } != ERROR_IO_PENDING {
                    return Err(IoError::Closed);
                }
                // SAFETY: `event` is a valid event handle for the life of `self`.
                if unsafe { WaitForSingleObject(self.event, ms_until(deadline)) } != WAIT_OBJECT_0 {
                    // SAFETY: `ov` is the operation just started on `pipe` and stays alive until GetOverlappedResult below has waited it out.
                    unsafe { CancelIoEx(self.pipe, &ov) };
                    let mut n = 0u32;
                    // SAFETY: as above; waiting (bWait = TRUE) is what makes it safe to drop `ov` and the buffer afterwards.
                    let ok = unsafe { GetOverlappedResult(self.pipe, &ov, &mut n, 1) };
                    return if ok != 0 && n > 0 { Ok(n as usize) } else { Err(IoError::Timeout) };
                }
            }
            let mut n = 0u32;
            // SAFETY: the operation has completed, so this only reads its result.
            if unsafe { GetOverlappedResult(self.pipe, &ov, &mut n, 0) } == 0 {
                return Err(IoError::Closed);
            }
            Ok(n as usize)
        }

        /// Up to `buf.len()` bytes; `Ok(0)` never happens (a closed pipe is `Closed`).
        pub fn read(&mut self, buf: &mut [u8], deadline: Instant) -> Result<usize, IoError> {
            let len = buf.len().min(u32::MAX as usize) as u32;
            let ptr = buf.as_mut_ptr();
            // SAFETY: `buf` outlives the operation, which `transfer` always waits out before returning.
            let n = self.transfer(deadline, |pipe, ov| unsafe { ReadFile(pipe, ptr, len, null_mut(), ov) })?;
            if n == 0 { Err(IoError::Closed) } else { Ok(n) }
        }

        pub fn write_all(&mut self, mut buf: &[u8], deadline: Instant) -> Result<(), IoError> {
            while !buf.is_empty() {
                let len = buf.len().min(u32::MAX as usize) as u32;
                let ptr = buf.as_ptr();
                // SAFETY: as for `read`.
                let n = self.transfer(deadline, |pipe, ov| unsafe { WriteFile(pipe, ptr, len, null_mut(), ov) })?;
                if n == 0 {
                    return Err(IoError::Closed);
                }
                buf = &buf[n..];
            }
            Ok(())
        }
    }
}

#[cfg(unix)]
mod imp {
    use std::io::{ErrorKind, Read, Write};
    use std::os::unix::net::UnixStream;
    use std::time::Instant;

    use super::{ConnectError, IoError};

    pub struct Conn {
        stream: UnixStream,
    }

    fn timeout_error(e: &std::io::Error) -> bool {
        matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut)
    }

    impl Conn {
        /// A Unix socket connect either succeeds or fails at once; there is no pending state to put a deadline on.
        pub fn connect(endpoint: &str, _deadline: Instant) -> Result<Conn, ConnectError> {
            match UnixStream::connect(endpoint) {
                Ok(stream) => Ok(Conn { stream }),
                Err(e) if matches!(e.kind(), ErrorKind::NotFound | ErrorKind::ConnectionRefused) => Err(ConnectError::Absent),
                Err(_) => Err(ConnectError::Other),
            }
        }

        pub fn read(&mut self, buf: &mut [u8], deadline: Instant) -> Result<usize, IoError> {
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return Err(IoError::Timeout);
                }
                self.stream.set_read_timeout(Some(left)).map_err(|_| IoError::Closed)?;
                return match self.stream.read(buf) {
                    Ok(0) => Err(IoError::Closed),
                    Ok(n) => Ok(n),
                    Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                    Err(e) if timeout_error(&e) => Err(IoError::Timeout),
                    Err(_) => Err(IoError::Closed),
                };
            }
        }

        pub fn write_all(&mut self, mut buf: &[u8], deadline: Instant) -> Result<(), IoError> {
            while !buf.is_empty() {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return Err(IoError::Timeout);
                }
                self.stream.set_write_timeout(Some(left)).map_err(|_| IoError::Closed)?;
                match self.stream.write(buf) {
                    Ok(0) => return Err(IoError::Closed),
                    Ok(n) => buf = &buf[n..],
                    Err(e) if e.kind() == ErrorKind::Interrupted => {}
                    Err(e) if timeout_error(&e) => return Err(IoError::Timeout),
                    Err(_) => return Err(IoError::Closed),
                }
            }
            Ok(())
        }
    }
}

pub use imp::Conn;

/// Frames read off a [`Conn`], one at a time, each by a deadline.
pub struct FrameConn {
    conn: Conn,
    reader: crate::protocol::FrameReader,
    pending: std::collections::VecDeque<serde_json::Map<String, serde_json::Value>>,
    failed: bool,
}

/// Why no frame came back.
#[derive(Debug, PartialEq, Eq)]
pub enum FrameError {
    Timeout,
    Closed,
    Malformed,
}

impl FrameConn {
    pub fn new(conn: Conn) -> FrameConn {
        FrameConn { conn, reader: Default::default(), pending: Default::default(), failed: false }
    }

    pub fn send(&mut self, frame: &[u8], deadline: Instant) -> Result<(), IoError> {
        self.conn.write_all(frame, deadline)
    }

    /// The next complete frame, or why none arrived by `deadline`. A malformed frame ends the stream, as `readFrames` destroys the socket.
    pub fn next(&mut self, deadline: Instant) -> Result<serde_json::Map<String, serde_json::Value>, FrameError> {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            if let Some(frame) = self.pending.pop_front() {
                return Ok(frame);
            }
            if self.failed {
                return Err(FrameError::Malformed);
            }
            let n = self.conn.read(&mut buf, deadline).map_err(|e| match e {
                IoError::Timeout => FrameError::Timeout,
                IoError::Closed => FrameError::Closed,
            })?;
            let decoded = self.reader.push(&buf[..n]);
            self.pending.extend(decoded.frames);
            self.failed = decoded.error.is_some();
        }
    }
}
