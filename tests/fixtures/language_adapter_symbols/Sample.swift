// HAND-DERIVED: standard Swift syntax written from language knowledge, not from any adapter regex.
import Foundation

struct Item {
    var name: String
    var quantity: Int
}

class Warehouse {
    private var items: [Item] = []

    func addItem(_ item: Item) {
        items.append(item)
    }
}

protocol Describable {
    func describe() -> String
}
