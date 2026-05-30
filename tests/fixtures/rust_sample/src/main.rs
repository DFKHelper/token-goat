use std::collections::HashMap;
use std::fmt;

pub const VERSION: &str = "0.1.0";
pub static MAX_CONNECTIONS: usize = 100;

pub struct Server {
    pub name: String,
    pub port: u16,
}

pub trait Handler {
    fn serve(&self, req: &str) -> Result<(), Box<dyn std::error::Error>>;
    async fn preflight(&self, req: &str) -> bool;
}

pub enum Error {
    NotFound,
    Internal(String),
}

impl Server {
    pub fn new(name: String, port: u16) -> Self {
        Server { name, port }
    }

    pub fn run(&self) -> Result<(), Error> {
        println!("starting {}", self.name);
        Ok(())
    }
}

fn main() {
    let s = Server::new("api".to_string(), 8080);
    s.run().unwrap();
}
