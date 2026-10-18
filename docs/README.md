# TS-Git documentation

Source for the TS-Git docs site at <https://tsgit.keydown.app>, built with [Astro](https://astro.build) and [Starlight](https://starlight.astro.build).

## Development

From the repository root:

```bash
pnpm install
pnpm docs          # dev server via turbo
```

Or from this directory:

| Command          | Action                                      |
| ---------------- | ------------------------------------------- |
| `pnpm dev`       | Start the dev server at `localhost:4321`    |
| `pnpm build`     | Build the static site into `./dist/`        |
| `pnpm preview`   | Preview the production build locally        |

## Layout

```
docs/
├── astro.config.mjs        # Starlight config and sidebar
├── public/                 # favicon.svg, icon.svg (brand mark)
└── src/
    ├── components/
    │   ├── Hero.astro      # homepage hero (Starlight override)
    │   ├── Sidebar.astro   # sidebar with alpha notice (Starlight override)
    │   └── home/           # diff backdrop, code card, scroll reveal
    ├── content/docs/       # pages (.md / .mdx), one route per file
    └── styles/custom.css   # brand colours and homepage styling
```

## Writing docs

- Pages live in `src/content/docs/`. Add new pages to the sidebar in `astro.config.mjs`.
- Use root-relative links with a trailing slash, e.g. `[status](/commands/status/)`.
- Keep API names and options in sync with `packages/ts-git/src` (exports in `src/index.ts`).
