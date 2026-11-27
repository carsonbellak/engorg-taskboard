/* =====================================================================
 * PORTFOLIO CONTENT. This is the only file you need to edit.
 *
 * Served at  https://assistant-taskboard.web.app/portfolio
 * Files go in pwa/portfolio/assets/ and are referenced as
 *   '/portfolio/assets/<folder>/<file>'   (always start with /portfolio/)
 *
 *   assets/images/  photos, renders, screenshots (.jpg .png .webp .gif)
 *   assets/models/  3D models: .stl .glb .gltf .obj .step .stp
 *                   (STL/GLB load instantly; STEP pulls a ~7 MB converter the
 *                    first time, so export GLB/STL for big assemblies)
 *   assets/pcb/     KiCad files: .kicad_pcb .kicad_sch (rendered live, zoomable)
 *   assets/video/   .mp4 .webm
 *   assets/resume.pdf   the Resume button hides itself until this file exists
 *
 * A project's `media` list is its gallery. Each item is one of:
 *   { type: 'image', src, caption }
 *   { type: 'model', src, caption, color: '#hex', zUp: true|false }
 *       zUp defaults to true for STL/STEP (CAD exports) and false for GLB/OBJ.
 *   { type: 'pcb',   src, caption }              one KiCad file, or
 *   { type: 'pcb',   files: [pcb, sch], caption } board + schematic together
 *   { type: 'video', src, caption, poster }
 *   Any item can have `label: 'Short name'` for its gallery tab (default: 3D / PCB / Video).
 *   { type: 'embed', src, caption }              any iframe-able viewer, e.g. an
 *       Onshape / Fusion 360 / Sketchfab / YouTube embed link
 *   An item with no src shows its caption as a "coming soon" placeholder.
 *
 * `notice` (optional) shows a highlighted note on the project, used here to say
 * how work designs were altered before publishing.
 *
 * WORK DESIGNS: never put a real work .kicad_pcb / STEP here. PCBs go through the
 * sanitizer (real outline + placement, random routing/nets/values) and models are
 * low-resolution meshes. Anything marked TODO is a placeholder.
 * ===================================================================== */

window.PORTFOLIO = {
  name: 'Carson Bellak',
  role: 'Engineering Student',                          // TODO, e.g. "Electrical Engineering · Purdue '27"
  tagline: '',                                         // optional one-liner under your name; '' shows none
  location: '',                                         // TODO (optional)
  status: '',                                          // (unused in the current layout)
  photo: '',                                            // TODO (optional) '/portfolio/assets/images/me.jpg'
  resume: '/portfolio/assets/resume.pdf',

  contact: {
    email: '',                                          // TODO
    linkedin: '',                                       // TODO full URL
    github: '',                                         // TODO full URL
  },

  // The interactive model in the header.
  // The rotating tile in the header: cycles through these models (spins each, then moves on).
  // `project` links the label to that project's section. Add an entry per model you make.
  showcase: [
    { model: '/portfolio/assets/models/optical-probe-mounted.glb', label: 'Optical probe shell', project: 'optical-probe', zUp: false },
    { model: '/portfolio/assets/models/little-blue-mounted.glb', label: 'Little Blue test cabinet', project: 'little-blue', zUp: false },
    { model: '/portfolio/assets/models/socket-plate-mounted.glb', label: 'Meter socket plate', project: 'socket-plate', zUp: false, view: [-1, 0.6, -1.3] },
    { model: '/portfolio/assets/models/spacer-shelled-mounted.glb', label: 'Injection-molded spacer', project: 'spacer', zUp: false },
    { model: '/portfolio/assets/models/calibration-cube-mounted.glb', label: '3D-printer calibration cube', project: 'calibration', zUp: false, view: [0.75, 0.55, -1.3] },
    { model: '/portfolio/assets/models/little-blue-exploded.glb', label: 'Little Blue, exploded', project: 'little-blue', zUp: false },
  ],

  about: [
    'I\'m an engineering student working on test equipment for electricity meters: probe hardware, a test cabinet and the tools used to check meters in bulk.',
    'Most of my work crosses disciplines: a board in KiCad, the enclosure or plate in Creo, then the Python that drives it on the bench. Outside work I build my own engineering tools, including the app this page is hosted on.',
  ],

  skills: [
    { group: 'Mechanical & CAD', items: ['Creo Parametric', 'Assembly design', 'Engineering drawings', 'FDM 3D printing', 'Design for manufacturing'] },
    { group: 'Electrical',       items: ['KiCad (4-layer boards)', 'Analog front ends (TIA)', 'USB / FTDI', 'Optical comms (ANSI C12.18)', 'Thermal & bench testing'] },
    { group: 'Software',         items: ['Python (PyQt5, Tkinter)', 'JavaScript / Node.js', 'Electron', 'Kotlin / Android', 'Firebase', 'Git'] },
    { group: 'Embedded & test',  items: ['Raspberry Pi', 'I²C', 'UART / RS-485', 'SSH automation', 'Test fixtures'] },
  ],

  projects: [
    {
      id: 'optical-probe',
      short: 'Optical probe',
      title: 'Optical probe redesign',
      date: '2026 · Industry project · REV0.D',
      org: '',                                          // TODO (optional) employer name
      summary: 'A redesigned USB optical probe for talking to electricity meters over their infrared port: a 4-layer board with a quad USB-UART bridge, an infrared transmitter and a transimpedance receiver, in a 3D-printed shell.',
      tags: ['Electrical', 'PCB', 'KiCad', '3D printing'],
      notice: 'Portfolio copy. The board outline, part placement and packages are real. The routing, net names and component values were replaced with randomly generated ones, and the shell is shown as a simplified mesh, to protect my employer\'s design.',
      links: [],
      body: [
        'Meters expose a standard infrared optical port (ANSI C12.18) for reading and configuration. This project was a ground-up redesign of the USB probe that clips onto that port, done on a small team through four board revisions.',
        'The board pairs an FTDI FT4232H quad USB-to-UART bridge with an infrared LED transmitter and a photodiode receiver feeding a transimpedance amplifier and comparator. Mini-USB on one end, the optical head on the other, on a 23 × 60 mm four-layer board.',
        'Most of the engineering was in the receive path. The goal was 921,600 baud, which needs clean edges of about 250 ns, while the first boards showed roughly 1 µs rise and 1.5 µs fall. Characterising that led to the main trade-off: the TIA feedback resistor sets gain against speed, so about 15 kΩ reaches 921,600 baud while about 50 kΩ is needed to pick up the meter\'s pulse output. It also pointed to the comparator as the next bottleneck.',
        'I also designed the enclosure in Creo: a two-piece 3D-printed shell that splits down the middle around the board, a separate head that holds the LEDs at the optical port, and a silicone mold for casting the cable strain reliefs.',
        'Thermal testing turned up a real failure: at 85 °C the receive line stays low and no data gets through, most likely DC leakage through the receive diode looping through the TIA. I documented the findings and the changes that did and did not help, so the next revision starts from the measurements.',
      ],
      media: [
        { type: 'model', label: 'Shell', src: '/portfolio/assets/models/optical-probe-mounted.glb', caption: 'Final printed shell: two halves and the LED head (simplified mesh)', zUp: false },
        { type: 'model', label: 'Exploded', src: '/portfolio/assets/models/optical-probe-exploded.glb', caption: 'Shell halves split apart', zUp: false },
        { type: 'pcb', label: 'Board', src: '/portfolio/assets/pcb/optical-probe.kicad_pcb', caption: 'Board view (scroll to zoom, click a part). Outline and placement are real; routing and values are randomized.' },
        { type: 'image', src: '', caption: 'TODO: a photo of the assembled probe on a meter' },
      ],
    },
    {
      id: 'little-blue',
      short: 'Little Blue',
      title: 'Little Blue test cabinet',
      date: '2025 to 2026 · Industry project',
      org: '',                                          // TODO (optional)
      summary: 'A rack-style test cabinet modelled end to end in Creo: a meter socket plate I designed and drew, rack-mount drawers, cooling, power and current-routing electronics in one assembly.',     // TODO: check the one-line purpose
      tags: ['Mechanical', 'CAD', 'Creo'],
      notice: 'Shown as simplified models only: coarse meshes with fasteners, board components and small details removed. Part numbers, the BOM and the source CAD are not published.',
      links: [],
      body: [
        'TODO: one or two sentences on what the cabinet tests and who uses it.',
        'I built the full top-level assembly in Creo Parametric: a 4U drawer and a 3U cabinet section with 120 mm filtered fan cooling, a 24 V supply, relay and current-ranging electronics, safety banana jacks for connections, and a socket plate that holds meters under test.',
        'The socket plate was my own part, documented with a dimensioned drawing. Integrating it meant fitting off-the-shelf rack hardware, fasteners and boards into one assembly that could be purchased against a BOM and built.',
      ],
      media: [
        { type: 'model', label: 'Mounted', src: '/portfolio/assets/models/little-blue-mounted.glb', caption: 'Assembled: every rack unit mounted (simplified model)', zUp: false },
        { type: 'model', label: 'Panels off', src: '/portfolio/assets/models/little-blue-panels-off.glb', caption: 'Side and rear panels removed to show the rack units inside', zUp: false },
        { type: 'model', label: 'Exploded', src: '/portfolio/assets/models/little-blue-exploded.glb', caption: 'Exploded: panels pushed out, units pulled from the rack', zUp: false },
      ],
    },
    {
      id: 'socket-plate',
      short: 'Socket plate',
      title: 'Meter socket plate',
      date: '2026 · Industry project · part of Little Blue',
      org: '',                                          // TODO (optional)
      summary: 'The plate inside Little Blue that holds two meter sockets under test, with the socket routing board and relays behind it. Designed in Creo and documented with a dimensioned drawing.',
      tags: ['Mechanical', 'CAD', 'Creo', 'Drawings'],
      notice: 'The 3D models are simplified: coarse meshes with fasteners and board components removed.',
      links: [],
      body: [
        'Meters under test plug into two standard meter sockets. I designed the front and back plates that carry them, spaced on standoffs so the socket routing board and its relays sit between the plates and the wiring stays short.',
        'The plate is a 19-inch rack-width panel, 19.00 × 11.75 in, with two large cutouts for the sockets, two slots for wiring and the mounting-hole pattern. The Drawing tab shows it fully dimensioned.',
        'TODO: anything about tolerancing, the shop that made it, or what changed between revisions.',
      ],
      media: [
        { type: 'model', label: 'Assembled', src: '/portfolio/assets/models/socket-plate-mounted.glb', caption: 'Socket plate assembly: two meter sockets, routing board and relays (simplified)', zUp: false, view: [-1, 0.6, -1.3] },
        { type: 'model', label: 'Exploded', src: '/portfolio/assets/models/socket-plate-exploded.glb', caption: 'Exploded through the stack: front plate, sockets, routing board, back plate', zUp: false, view: [-1.6, 0.5, -0.9] },
        { type: 'drawing', label: 'Drawing', src: '/portfolio/assets/drawings/socket-plate-drawing.pdf', caption: 'Socket plate drawing (zoom with + / −, or open the PDF)' },
      ],
    },
    {
      id: 'calibration',
      short: 'Printer calibration',
      title: '3D-printer calibration set',
      date: '2026 · Personal project',
      summary: 'Test parts I modelled in Creo to tune my Creality K1C: dimension cubes, a hollow cube for wall and bridging checks, and a 25 mm test cube.',
      tags: ['3D printing', 'CAD', 'Creo'],
      links: [],
      body: [
        'I keep a small set of calibration parts for my printer: 10, 25 and 50 mm cubes to check dimensional accuracy in each axis, a 50 mm cube hollowed to 25 mm for wall thickness and bridging, and the 25 mm test cube shown here.',
        'Measuring them after a profile change tells me straight away whether flow, shrinkage or the slicer settings have drifted, before printing a real part.',
      ],
      media: [
        { type: 'model', label: 'Test cube', src: '/portfolio/assets/models/calibration-cube-mounted.glb', caption: '25 mm calibration test cube (drag to orbit)', zUp: false, view: [0.75, 0.55, -1.3] },
      ],
    },
    {
      id: 'spacer',
      short: 'Molded spacer',
      title: 'Injection-molded spacer',
      date: '2026',
      org: '',                                          // TODO (optional)
      summary: 'A 125 mm spacer taken from a solid printed prototype to a part designed for injection molding.',
      tags: ['Mechanical', 'CAD', 'Creo', 'Injection molding'],
      links: [],
      body: [
        'Three iterations of the same 125 × 27 × 10 mm spacer. The solid version proved the fit; the shelled version hollows it out to an even wall thickness, which is what lets a part fill and cool evenly in an injection mold without sink marks or warping; the slotted version is a further variant of that geometry.',
        'TODO: what the spacer goes into, the material, and anything learned from the molder (draft, gate location, tolerances).',
      ],
      media: [
        { type: 'model', label: 'Shelled', src: '/portfolio/assets/models/spacer-shelled-mounted.glb', caption: 'Shelled to a uniform wall for molding', zUp: false },
        { type: 'model', label: 'Solid', src: '/portfolio/assets/models/spacer-solid-mounted.glb', caption: 'First iteration: solid', zUp: false },
        { type: 'model', label: 'Slotted', src: '/portfolio/assets/models/spacer-slotted-mounted.glb', caption: 'Slotted variant', zUp: false },
      ],
    },
    {
      id: 'wifi-checker',
      short: 'Wifi Checker',
      title: 'Wifi Checker: fleet test tool',
      date: '2025 to 2026 · Industry project',
      org: '',                                          // TODO (optional)
      summary: 'A desktop tool that finds every meter on the network by MAC address, checks Wi-Fi connectivity over ping and SSH, pushes settings in bulk and writes Excel reports, including unattended scheduled runs.',
      tags: ['Software', 'Python', 'Test automation'],
      links: [],
      body: [
        'Testing meter Wi-Fi meant checking dozens of devices by hand. I took an earlier internal script by two colleagues and rebuilt it into a full PyQt5 application of about 3,000 lines.',
        'It reads a meter status spreadsheet, sweeps the lab subnets in parallel to map each meter\'s MAC address to its current IP, then pings and opens an SSH session to every meter on a thread pool. Each run writes per-meter pass/fail results and timing to Excel.',
        'Later versions added continuous and scheduled ping sessions (pick days, a start time and a duration, then leave it running overnight), a bulk temperature-shutdown push to selected meters over SSH, multiple test tabs with saved profiles, and a frameless custom UI. It ships as a standalone .exe that installs its own dependencies on first run.',
      ],
      media: [
        { type: 'image', src: '', caption: 'TODO: a screenshot of the scan view (blur any IPs or MAC addresses)' },
      ],
    },
    {
      id: 'contactor-tester',
      short: 'Contactor tester',
      title: 'Three-phase contactor tester',
      date: '2026 · Industry project',
      org: '',                                          // TODO (optional)
      summary: 'A Raspberry Pi touchscreen app that drives six three-phase contactors through an I²C GPIO expander and checks each one actually switched using independent sense inputs.',
      tags: ['Software', 'Python', 'Embedded'],
      links: [],
      body: [
        'Built around an MCP23008 I²C GPIO expander driving the low and high contactors on phases A, B and C, plus a direction control for an H-bridge.',
        'A second set of inputs, either a second MCP23008 or the Pi\'s own GPIO, reads back each contactor\'s real state. The UI shows commanded against sensed state per contactor and flags any mismatch, so a stuck contactor is caught instead of assumed.',
        'It includes a live register inspector for the expander, works across Raspberry Pi generations (RPi.GPIO on older boards, gpiozero/lgpio on the Pi 5), and falls back to a mock device so the interface can be developed and demonstrated without hardware.',
      ],
      media: [
        { type: 'image', src: '', caption: 'TODO: a photo of the tester or a screenshot of the UI' },
      ],
    },
    {
      id: 'engorg',
      short: 'EngOrg',
      title: 'EngOrg: engineering workspace',
      date: '2025 to present · Personal project',
      summary: 'A desktop app, phone app, Android notebook and Raspberry Pi service I built to run my engineering coursework and lab work from one place.',
      tags: ['Software', 'Electron', 'Android', 'Embedded'],
      links: [{ label: 'Open the web app', url: 'https://assistant-taskboard.web.app' }],
      body: [
        'EngOrg started as a task board and grew into a full workspace: projects and deadlines pulled in automatically from Gradescope, Brightspace and calendar feeds; a 3D-printer dashboard that talks to Klipper over Moonraker and slices with OrcaSlicer; a CAD viewer; and a set of engineering utilities including a circuit simulator, a thermodynamics solver and a UART bridge.',
        'It runs on four platforms that share one data model through Firebase: an Electron desktop app, an installable web app, an Android pen-notebook app (EngInk) that recognises hand-drawn circuit symbols and solves them, and a headless Raspberry Pi build that keeps printer logs and calendar caches running 24/7.',
        'Everything ships through a release pipeline I wrote: one command versions the desktop installer, the Android APK and the Pi bundle, and linked Raspberry Pis update themselves.',
      ],
      media: [
        { type: 'image', src: '', caption: 'TODO: add a screenshot, e.g. /portfolio/assets/images/engorg-board.png' },
      ],
    },
  ],
};
