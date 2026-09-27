<script setup lang="ts">
// At the foot of every page: what the panel is built on, and where it lives.
const REPO = 'https://github.com/jinqians/proxy-stack'
</script>

<template>
  <footer class="footer" data-test="footer">
    Powered by <a :href="REPO" target="_blank" rel="noopener noreferrer" data-test="powered-by">PSM</a>
  </footer>
</template>
