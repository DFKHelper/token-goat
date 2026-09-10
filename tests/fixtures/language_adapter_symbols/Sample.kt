// HAND-DERIVED: standard Kotlin syntax written from language knowledge, not from any adapter regex.
package com.example.inventory

data class Item(val name: String, val quantity: Int)

class Warehouse {
    private val items = mutableListOf<Item>()

    fun addItem(item: Item) {
        items.add(item)
    }

    fun totalQuantity(): Int = items.sumOf { it.quantity }
}

interface Describable {
    fun describe(): String
}
