// HAND-DERIVED: standard Java syntax written from language knowledge, not from any adapter regex.
package com.example.inventory;

import java.util.HashMap;
import java.util.Map;

public class Sample {
    private Map<String, Integer> items = new HashMap<>();

    public void addItem(String name, int qty) {
        items.put(name, qty);
    }

    public int totalItems() {
        return items.values().stream().mapToInt(Integer::intValue).sum();
    }
}

interface Describable {
    String describe();
}
