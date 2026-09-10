// HAND-DERIVED: standard Rust syntax written from language knowledge, not from any adapter regex.
use std::collections::HashMap;

pub struct Inventory {
    items: HashMap<String, u32>,
}

impl Inventory {
    pub fn new() -> Self {
        Inventory { items: HashMap::new() }
    }

    pub fn add_item(&mut self, name: &str, qty: u32) {
        self.items.insert(name.to_string(), qty);
    }
}

pub enum Status {
    Active,
    Retired,
}

pub trait Describable {
    fn describe(&self) -> String;
}
