// HAND-DERIVED: standard Dart syntax written from language knowledge, not from any adapter regex.
class Item {
  final String name;
  final int quantity;

  Item(this.name, this.quantity);
}

class Warehouse {
  final List<Item> items = [];

  void addItem(Item item) {
    items.add(item);
  }
}

abstract class Describable {
  String describe();
}
