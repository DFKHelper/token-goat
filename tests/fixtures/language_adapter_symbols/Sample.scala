// HAND-DERIVED: standard Scala syntax written from language knowledge, not from any adapter regex.
package com.example.inventory

case class Item(name: String, quantity: Int)

class Warehouse {
  private var items: List[Item] = List()

  def addItem(item: Item): Unit = {
    items = item :: items
  }
}

trait Describable {
  def describe(): String
}
