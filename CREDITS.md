# Credits and provenance

- Product concept, prototype specification, and direction: Mayank Daswani.
- A local prototype built on 31 October 2026 explored the code-city metaphor, time scrubbing, gates, shortcuts, and desire paths. Its design and force-layout approach informed this build. It was not copied into the public repository. Earlier private datasets and unverified metric claims are not shipped.
- This implementation’s scanner, 3D view, local server, Codex app-server client, Decisions adapter, hooks, tests, and synthetic fixture were created during the 1 November hackathon with Codex.
- Three.js provides 3D rendering and OrbitControls (MIT).
- D3 force and polygon packages provide layout and geometry helpers (ISC).
- TypeScript 5.9.3 provides the JS/TS parser (Apache-2.0). It is pinned because the 7.x compiler API changed.
- esbuild bundles the browser and standalone plugin parser (MIT).
- fix-webm-duration supplies missing duration metadata for browser-recorded films (MIT).
- No prebuilt 3D model or stock image is used. City geometry is generated from analysis data.
- Narrated videos use Explainroo 0.4.1 by Vincent Schmalbach (MIT), pinned to `e95232c8d535ed2aa390e7b1caee0d1326dd9e83`: https://github.com/vincentsch/explainroo. Its existing renderer, scene API, speech alignment, and bundled Instrument Serif, Inter, and JetBrains Mono fonts (SIL Open Font License) provide the video tooling and typography. See its upstream credits for Whisper, Rough.js, Lucide, and FFmpeg.
- Narration uses OpenAI GPT-Audio-1.5, Marin, and is labeled as an AI voice. Video scripts, scene composition, and the app integration were created during the hackathon.
- Optional city portraits are AI-generated through Codex from the current rendered city, and are labeled as illustrations rather than measured geometry. Private portraits are not bundled with source.

Dependency versions and integrity hashes are recorded in `package-lock.json`. Their licenses remain in their packages; bundled license notices accompany built assets.
