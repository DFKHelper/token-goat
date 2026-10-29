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
    use windows_sys::Win32::System::Threading::{CreateEventW, ResetEvent, WaitForSingleObject};

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
            // SAFETY: this connection owns a valid event handle and starts only one transfer at a time.
            if unsafe { ResetEvent(self.event) } == 0 {
                return Err(IoError::Closed);
            }
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

    #[cfg(test)]
    mod windows_event_tests {
        use std::mem::ManuallyDrop;
        use std::time::Duration;

        use super::*;

        struct EventGuard(HANDLE);

        impl Drop for EventGuard {
            fn drop(&mut self) {
                // SAFETY: this test is the sole owner of the event handle.
                unsafe { CloseHandle(self.0) };
            }
        }

        #[test]
        fn transfer_resets_a_signaled_event_before_starting_io() {
            // SAFETY: null attributes and name are accepted; the returned handle is checked below.
            let event = unsafe { CreateEventW(null(), 1, 1, null_mut()) };
            assert!(!event.is_null(), "CreateEventW must return a valid event");
            let _event_guard = EventGuard(event);
            let mut conn = ManuallyDrop::new(Conn {
                pipe: INVALID_HANDLE_VALUE,
                event,
            });
            let mut was_signaled = true;
            // The pipe sentinel is not an I/O endpoint; this test asserts only the event state at start.
            let _transfer_result = conn.transfer(Instant::now() + Duration::from_secs(1), |_, overlapped| {
                // SAFETY: transfer supplies a valid OVERLAPPED whose event is owned above.
                was_signaled = unsafe { WaitForSingleObject((*overlapped).hEvent, 0) } == WAIT_OBJECT_0;
                1
            });
            assert!(!was_signaled, "transfer must clear the previous operation's event signal before starting");
        }
    }
}

#[cfg(unix)]
mod imp {
    use std::io::{ErrorKind, Read, Write};
    use std::mem::{offset_of, size_of, zeroed};
    use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd};
    use std::os::unix::net::UnixStream;
    use std::time::Instant;

    use super::{ConnectError, IoError};

    pub struct Conn {
        stream: UnixStream,
    }

    fn timeout_error(e: &std::io::Error) -> bool {
        matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut)
    }

    fn wait_for_connect(fd: libc::c_int, deadline: Instant) -> Result<(), ConnectError> {
        let mut descriptor = libc::pollfd { fd, events: libc::POLLOUT, revents: 0 };
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(ConnectError::Other);
            }
            let timeout_ms = left.as_millis().clamp(1, i32::MAX as u128) as i32;
            descriptor.revents = 0;
            let ready = unsafe { libc::poll(&mut descriptor, 1, timeout_ms) };
            if ready < 0 {
                if std::io::Error::last_os_error().kind() == ErrorKind::Interrupted {
                    continue;
                }
                return Err(ConnectError::Other);
            }
            if ready == 0 {
                continue;
            }

            let mut socket_error = 0;
            let mut socket_error_len = size_of::<libc::c_int>() as libc::socklen_t;
            if unsafe {
                libc::getsockopt(
                    fd,
                    libc::SOL_SOCKET,
                    libc::SO_ERROR,
                    (&mut socket_error as *mut libc::c_int).cast(),
                    &mut socket_error_len,
                )
            } < 0
            {
                return Err(ConnectError::Other);
            }
            if socket_error == 0 {
                return if Instant::now() < deadline { Ok(()) } else { Err(ConnectError::Other) };
            }
            if socket_error == libc::ENOENT || socket_error == libc::ECONNREFUSED {
                return Err(ConnectError::Absent);
            }
            if socket_error != libc::EINPROGRESS && socket_error != libc::EALREADY {
                return Err(ConnectError::Other);
            }
        }
    }

    impl Conn {
        /// Connects without blocking past the caller's handshake deadline.
        pub fn connect(endpoint: &str, deadline: Instant) -> Result<Conn, ConnectError> {
            if Instant::now() >= deadline || endpoint.as_bytes().contains(&0) {
                return Err(ConnectError::Other);
            }
            let socket_fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
            if socket_fd < 0 {
                return Err(ConnectError::Other);
            }
            let socket = unsafe { OwnedFd::from_raw_fd(socket_fd) };
            let descriptor_flags = unsafe { libc::fcntl(socket.as_raw_fd(), libc::F_GETFD) };
            let status_flags = unsafe { libc::fcntl(socket.as_raw_fd(), libc::F_GETFL) };
            if descriptor_flags < 0
                || status_flags < 0
                || unsafe { libc::fcntl(socket.as_raw_fd(), libc::F_SETFD, descriptor_flags | libc::FD_CLOEXEC) } < 0
                || unsafe { libc::fcntl(socket.as_raw_fd(), libc::F_SETFL, status_flags | libc::O_NONBLOCK) } < 0
            {
                return Err(ConnectError::Other);
            }

            let path = endpoint.as_bytes();
            let mut address: libc::sockaddr_un = unsafe { zeroed() };
            if path.len() >= address.sun_path.len() {
                return Err(ConnectError::Other);
            }
            address.sun_family = libc::AF_UNIX as _;
            for (slot, byte) in address.sun_path.iter_mut().zip(path) {
                *slot = *byte as libc::c_char;
            }
            address.sun_path[path.len()] = 0;
            let address_len = offset_of!(libc::sockaddr_un, sun_path) + path.len() + 1;
            #[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd", target_os = "openbsd", target_os = "netbsd", target_os = "dragonfly"))]
            {
                address.sun_len = address_len as u8;
            }
            let address_len = match libc::socklen_t::try_from(address_len) {
                Ok(length) => length,
                Err(_) => return Err(ConnectError::Other),
            };
            let connected = unsafe {
                libc::connect(
                    socket.as_raw_fd(),
                    (&address as *const libc::sockaddr_un).cast(),
                    address_len,
                )
            };
            if connected < 0 {
                let error = std::io::Error::last_os_error().raw_os_error().unwrap_or_default();
                if error == libc::ENOENT || error == libc::ECONNREFUSED {
                    return Err(ConnectError::Absent);
                }
                if error == libc::EINPROGRESS || error == libc::EALREADY || error == libc::EINTR {
                    wait_for_connect(socket.as_raw_fd(), deadline)?;
                } else {
                    return Err(ConnectError::Other);
                }
            }
            if Instant::now() >= deadline {
                return Err(ConnectError::Other);
            }

            let status_flags = unsafe { libc::fcntl(socket.as_raw_fd(), libc::F_GETFL) };
            if status_flags < 0 || unsafe { libc::fcntl(socket.as_raw_fd(), libc::F_SETFL, status_flags & !libc::O_NONBLOCK) } < 0 {
                return Err(ConnectError::Other);
            }
            let stream = unsafe { UnixStream::from_raw_fd(socket.into_raw_fd()) };
            Ok(Conn { stream })
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

#[cfg(all(test, unix))]
mod unix_connect_tests {
    use std::fs;
    use std::os::unix::net::UnixListener;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, Instant};

    use super::{ConnectError, imp::Conn};

    static NEXT_SOCKET: AtomicU64 = AtomicU64::new(0);

    struct SocketPath(PathBuf);

    impl Drop for SocketPath {
        fn drop(&mut self) {
            match fs::remove_file(&self.0) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => panic!("could not remove test socket {}: {error}", self.0.display()),
            }
        }
    }

    #[test]
    fn connect_refuses_an_already_expired_deadline() {
        let path = std::env::temp_dir().join(format!(
            "tg-{}-{}.sock",
            std::process::id(),
            NEXT_SOCKET.fetch_add(1, Ordering::Relaxed),
        ));
        let _cleanup = SocketPath(path.clone());
        let _listener = UnixListener::bind(&path).expect("bind test listener");
        let deadline = Instant::now().checked_sub(Duration::from_secs(1)).expect("past deadline");
        assert!(matches!(Conn::connect(path.to_str().expect("UTF-8 temp path"), deadline), Err(ConnectError::Other)));
    }
}

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
