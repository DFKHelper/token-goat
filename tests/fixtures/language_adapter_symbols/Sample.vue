<!-- HAND-DERIVED: standard Vue single-file-component syntax written from language knowledge, not from any adapter regex. -->
<template>
  <div class="item-card">
    <ItemBadge :name="itemName" />
  </div>
</template>

<script>
export default {
  name: 'ItemCard',
  props: {
    itemName: String,
  },
  methods: {
    addQuantity(a, b) {
      return a + b
    },
  },
}
</script>
