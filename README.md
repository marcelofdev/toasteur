# Toasteur

Accessible, dependency-free toast notifications. Toasteur is the engine of the **CustomToastNotification** component for OutSystems O11 and ODC.

**Live playground:** https://marcelofdev.github.io/toasteur/
**OutSystems demo with full documentation:** https://marcelo-ferreira72.outsystemscloud.com/CustomToastNotificationDEMO/

## Why

- **Screen readers announce every toast.** Two persistent live regions (polite for success, info and warning; assertive for errors) exist before the first toast. Live regions inserted together with their content are often skipped by NVDA and VoiceOver.
- **No focus stealing by default.** Keyboard focus never moves on its own (WCAG 3.2). Focus on error toasts is opt-in (`focusOnError`).
- **Timers respect the user (WCAG 2.2.1).** The countdown pauses on hover, on keyboard focus and while the tab is hidden. `duration: 0` keeps a toast until it is closed.
- **Bounded queue and deduplication.** `maxVisible` toasts per position, a bounded queue (`maxQueued`), and identical messages merged into one toast with a counter.
- **Safe.** Content is inserted as text, never as HTML. `configure()` ignores invalid values with a console warning instead of throwing.
- **Optional sound** per type, generated with the Web Audio API, with a per-session mute button.
- Two themes, five positions, `prefers-reduced-motion` support, brand colors through CSS custom properties.

## Use in OutSystems

Install **CustomToastNotification** from the Forge, place the `ToastNotification` block once in the Layout (outside any Placeholder) and call the `ShowToast` client action:

```
ShowToast(
    Message = "Your changes have been saved.",
    Type = Entities.Toast_Type.Success,
    Title = "Saved"
)
```

`ShowToast` never throws: it returns `IsSuccess` and `ErrorMessage`. Application settings (theme, MaxVisible, MaxQueued, DefaultDuration, EnableSound, FocusOnError and eight accessibility labels) are inputs of the block.

## Use anywhere else

```html
<link rel="stylesheet" href="toasteur.css">
<script src="toasteur.js"></script>
<script>
  Toasteur.configure({ theme: "tinted", maxVisible: 5 });
  Toasteur.show({ type: "success", title: "Saved", message: "Your changes have been saved." });
  Toasteur.error("Unable to process your request.", "Error", { duration: 0 });
</script>
```

### `Toasteur.configure(options)`

| Option | Type | Default | Notes |
|---|---|---|---|
| `theme` | `"tinted"` or `"solid"` | `"tinted"` | |
| `maxVisible` | Number | 5 | Visible toasts per position; the rest are queued. |
| `maxQueued` | Number | 20 | Queued toasts per position; the excess is dropped with a console warning. |
| `defaultDuration` | Number (ms) | 4000 | Used when `show()` gets no duration. |
| `sound` | Boolean | false | |
| `focusOnError` | Boolean | false | Moves focus to the close button of error toasts. |
| `labels` | Object | English | `success`, `error`, `info`, `warn`, `close`, `mute`, `unmute`, `notificationsRegion`. |

### `Toasteur.show(options)`

| Option | Type | Default |
|---|---|---|
| `type` | `"success"`, `"error"`, `"info"`, `"warn"` | required |
| `message` | String | required |
| `title` | String | empty |
| `position` | `"top-right"`, `"top-left"`, `"top-center"`, `"bottom-right"`, `"bottom-left"` | `"top-right"` |
| `duration` | Number (ms), 0 = until closed | `defaultDuration` |
| `showProgressBar` | Boolean | true |
| `allowDuplicate` | Boolean | false |
| `onClick` | Function | none; makes the toast focusable and operable with Enter or Space |

Shortcuts: `Toasteur.success / error / info / warn(message, title, options)`.

`show()` throws on an invalid type, position, duration or an empty message. In OutSystems, `ShowToast` catches this and returns it in `ErrorMessage`.

### Theming

```css
.toasteur-notification.info { --toasteur-accent: #7c3aed; --toasteur-tint: #f3efff; }
.toasteur-container { --toasteur-top-offset: 64px; } /* below a fixed header */
```

## License

MIT
