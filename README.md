# Extension Sets (SillyTavern extension)

Save named sets of enabled/disabled extensions and switch between them in one click, with an optional per-device set that applies itself — handy if you run a lightweight setup on your phone and a full one on your PC.

**Alpha.** Working title. Client-side only: no server plugin needed.

## Use

Wand menu → **Extension Sets**.

1. Get your extensions how you want them on this device (Extensions drawer, toggle as usual).
2. **Save the current setup as a new set** — give it a name (e.g. "Phone (lightweight)").
3. Repeat on your other device with its own name.
4. Under **This device**, pick which set this device uses.

**Apply…** shows exactly what would be turned on and off (plus dependency warnings and extensions that aren't installed here) before anything changes. SillyTavern then reloads once.

## How devices share one list

SillyTavern keeps the enabled/disabled list on the server, so every device sees the same one. Sets are stored there too, so they show up everywhere, but *which set a device uses* is stored in that browser only.

On each device, auto-apply waits for SillyTavern to fully finish loading (its `APP_READY` event) before touching anything — applying a set earlier than that can race ST's own startup and silently fail to save, which used to show up as a "tried too fast" warning on some boots. Manually clicking **Apply…** in the dialog is unaffected either way.

The rule: **the last device to apply a set owns the shared state.** When a device with a set assigned loads and finds another device applied last, it applies its own set (one reload). It never re-applies on top of its own apply, so manual toggles survive reloads. Switch from phone to PC and back and each device flips the state exactly once.

Safety: it never toggles itself, ignores set entries that aren't installed on this server, and won't auto-reload more than twice in two minutes if something goes wrong.

## Install

Copy this folder into `SillyTavern/data/<your-user>/extensions/extension-sets/` and reload SillyTavern. It then loads on every device pointed at that server.


## License

[WTFPL](LICENSE) — do what the fuck you want to.
