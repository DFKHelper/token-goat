<!-- HAND-DERIVED: standard Svelte component syntax written from language knowledge, not from any adapter regex. -->
<script>
  export let itemName
  export let quantity = 0

  function addQuantity(a, b) {
    return a + b
  }
</script>

<div class="item-card">
  <ItemBadge name={itemName} />
  <p>{quantity}</p>
</div>
