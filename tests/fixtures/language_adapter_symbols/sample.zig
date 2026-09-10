// HAND-DERIVED: standard Zig syntax written from language knowledge, not from any adapter regex.
const std = @import("std");

pub const Item = struct {
    name: []const u8,
    quantity: u32,
};

pub fn addQuantity(a: u32, b: u32) u32 {
    return a + b;
}
