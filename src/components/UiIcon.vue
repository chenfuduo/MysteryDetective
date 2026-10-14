<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{ name: string; size?: number }>(), { size: 20 })
const paths: Record<string, string> = {
  archive: 'M3 5h18v4H3z M5 9v11h14V9 M9 13h6',
  board: 'M3 4h18v16H3z M7 8h5v4H7z M15 8h3 M15 12h3 M7 16h11',
  camera: 'M4 7h3l2-3h6l2 3h3v13H4z M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  check: 'M4 12l5 5L20 6',
  chevron: 'M9 18l6-6-6-6',
  close: 'M5 5l14 14M19 5L5 19',
  compare: 'M3 4h8v16H3z M13 4h8v16h-8z',
  download: 'M12 3v12m0 0l-4-4m4 4l4-4 M4 17v4h16v-4',
  edit: 'M4 20h4l11-11-4-4L4 16z M13 7l4 4',
  file: 'M6 3h8l4 4v14H6z M14 3v5h5 M9 13h6M9 17h6',
  filter: 'M4 6h16 M7 12h10 M10 18h4',
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  heart: 'M20 8c0 5-8 11-8 11S4 13 4 8a4 4 0 0 1 8-2 4 4 0 0 1 8 2z',
  image: 'M3 4h18v16H3z M7 9h.01 M3 17l5-5 4 4 3-3 6 6',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 11v5 M12 7h.01',
  list: 'M4 6h16M4 12h16M4 18h16',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  note: 'M5 3h14v18l-4-3-4 3-3-3-3 3z M9 8h6 M9 12h6',
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 20a8 8 0 0 1 16 0',
  people: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M2 21a7 7 0 0 1 14 0 M17 4a4 4 0 0 1 0 8 M19 14a7 7 0 0 1 3 7',
  plus: 'M12 4v16M4 12h16',
  rotate: 'M4 11a8 8 0 1 1 2 7 M4 6v5h5',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M17 17l5 5',
  spark: 'M12 2l2 7 7 2-7 2-2 7-2-7-7-2 7-2z',
  tag: 'M3 4h9l9 9-8 8-10-10z M7 8h.01',
  timeline: 'M5 3v18 M5 7h12 M5 13h8 M5 19h14 M18 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z M14 11a2 2 0 1 0 0 4 2 2 0 0 0 0-4z M20 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 14h10l1-14 M10 11v7 M14 11v7',
  upload: 'M12 16V3m0 0L8 7m4-4l4 4 M4 16v5h16v-5',
  zoomIn: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M8 11h6 M11 8v6 M17 17l5 5',
  zoomOut: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M8 11h6 M17 17l5 5',
}
const d = computed(() => paths[props.name] || paths.file)
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="d" /></svg>
</template>
