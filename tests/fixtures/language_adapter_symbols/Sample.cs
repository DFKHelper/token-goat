// HAND-DERIVED: standard C# syntax written from language knowledge, not from any adapter regex.
using System;

namespace Inventory
{
    public class Item
    {
        public string Name { get; set; }
        public int Quantity { get; set; }

        public void Print()
        {
            Console.WriteLine($"{Name}: {Quantity}");
        }
    }

    public interface IDescribable
    {
        string Describe();
    }
}
