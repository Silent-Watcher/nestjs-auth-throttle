import { defineConfig } from 'tsup';

// JavaScript is bundled by tsup. Declaration files are emitted by `tsc`
// (see tsconfig.build.json) because tsup's `dts` bundler depends on the
// TypeScript JS API, which TypeScript 7 no longer ships.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  outDir: 'dist',
  external: ['@nestjs/common', '@nestjs/core', 'reflect-metadata', 'rxjs'],
});
