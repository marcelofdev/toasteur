/*
 * Toasteur v5.2: Toast Notifications for OutSystems O11 / ODC
 * No dependencies. ES6+, no transpilation.
 *
 * Public API:
 *   Toasteur.configure(options): application-level configuration (call it in the Toast block's OnReady)
 *     { theme: "tinted"|"solid", maxVisible: Number, maxQueued: Number, defaultDuration: Number,
 *       sound: Boolean, focusOnError: Boolean,
 *       labels: { success, error, info, warn, close, mute, unmute, notificationsRegion } }
 *   Toasteur.show(options): displays a toast
 *     { type, message, title?, position?, duration?, showProgressBar?, allowDuplicate?, onClick? }
 *   Shortcuts: Toasteur.success/error/info/warn(message, title, options)
 *
 * New in v5.2:
 * - Reliable screen-reader announcements: toasts are announced through two
 *   persistent, visually hidden live regions (polite for success/info/warn,
 *   assertive for error) created before the first toast, instead of toasts
 *   that are born with aria-live. Screen readers only announce changes to a
 *   live region that already exists in the DOM; a freshly inserted
 *   role="status" element is often skipped by NVDA and VoiceOver.
 * - Focus on error is now opt-in (focusOnError, default false). Moving focus
 *   without a user request is a change of context (WCAG 3.2); the assertive
 *   announcement already reaches screen-reader users.
 * - Bounded, deduplicated queue: an identical message already waiting in the
 *   queue is not queued again, and the queue keeps at most maxQueued toasts
 *   per position (default 20), so an error raised in a loop cannot flood the
 *   screen for minutes.
 * - configure() never throws: invalid values are ignored with console.warn
 *   and the current value is kept. An invalid block input no longer breaks
 *   the Layout's OnReady on every screen.
 * - Clickable toasts (onClick) are keyboard operable: focusable, activated
 *   with Enter or Space.
 *
 * New in v5.1:
 * - Keyboard focus: error toasts (role="alert", the type most likely to need
 *   immediate reading or dismissal) now move keyboard focus to their close
 *   button when created. Without this, a toast is appended at the end of the
 *   DOM, and a keyboard-only user pressing Tab after triggering it lands on
 *   whatever comes next in the page's natural tab order, not the toast, so
 *   an urgent, persistent error could be effectively unreachable by keyboard.
 *   success/info/warn toasts do not steal focus, they are not urgent enough
 *   to justify moving the user's keyboard position without being asked.
 * - Larger close/mute hit area and extra spacing between them (see the v5.1
 *   CSS), reduces accidental taps on the wrong control.
 * - Header offset: containers positioned at the top of the screen now read
 *   --toasteur-top-offset (see the v5.1 CSS), so a consumer application with
 *   a fixed header can prevent the container from overlapping it.
 *
 * New in v5:
 * - New "top-center" position: container centered at the top of the screen,
 *   entering with a vertical slide (top to bottom) and exiting upwards,
 *   mirroring the entry. Requires the matching styles in the v5 CSS.
 * - Pause on visibilitychange: when the tab stops being visible, the timers of
 *   all toasts pause (preserving the remaining time) and resume when the user
 *   returns; a toast no longer expires unread. Toasts created while the tab
 *   is in the background are born paused.
 * - Pause-reason model (hover, focus, hidden): the three pause sources are
 *   composable; the timer only resumes when no reason remains.
 * - Focus pause now applies to keyboard focus only (:focus-visible): a mouse
 *   click on a toast button no longer leaves the timer paused after the mouse
 *   leaves. Also fixes a latent v4 defect where mouseleave resumed the timer
 *   even with keyboard focus inside the toast.
 * - Dismissal synchronized with the progress bar: when a bar exists, the toast
 *   closes on the animation's animationend (accurate, runs on the compositor),
 *   with setTimeout as fallback; removes the visible gap between the bar
 *   finishing and the toast leaving when the main thread is busy.
 * - Configurable accessibility labels (configure({ labels })), with English
 *   defaults; API error messages are now in English as well. Applications in
 *   other languages pass the labels through the block inputs.
 * - Visibility resync: on returning to the tab, the progress bar is rebuilt
 *   from the timer's remaining time (browsers do not reliably honor a pause
 *   applied while the page is hidden), and a stale animationend can no longer
 *   dismiss a toast whose timer still holds remaining time.
 *
 * New in v4:
 * - Optional sound (config.sound, default false): short Web Audio API tone
 *   when a new toast is created, differentiated by type; silent on
 *   deduplication reinforcement.
 * - Mute button on each toast (only when sound is enabled for the application):
 *   toggles silence for the whole user session (sessionStorage; in-memory
 *   fallback when storage is blocked).
 * - Browser autoplay policy: sound only plays after the user's first
 *   interaction with the page (best-effort, no error when blocked).
 */
(function (window, document) {
    "use strict";

    if (window.Toasteur) {
        return; // guard against loading the script twice
    }

    const POSITIONS = ["top-right", "top-left", "top-center", "bottom-right", "bottom-left"];
    const TYPES = ["success", "error", "info", "warn"];
    const THEMES = ["tinted", "solid"];
    const EXIT_ANIMATION_MS = 300; // keep aligned with the CSS (--toasteur-exit)
    const MUTE_STORAGE_KEY = "toasteur-sound-muted";

    /* Application-level configuration (changed via Toasteur.configure).
       Accessibility labels default to English; each application can override
       them via configure({ labels: {...} }) for localization. */
    const config = {
        theme: "tinted",
        maxVisible: 5,
        maxQueued: 20,
        defaultDuration: 4000,
        sound: false,
        focusOnError: false,
        labels: {
            success: "Success",
            error: "Error",
            info: "Information",
            warn: "Warning",
            close: "Close notification",
            mute: "Mute notification sounds",
            unmute: "Unmute notification sounds",
            notificationsRegion: "Notifications"
        }
    };

    const ICONS = {
        success:
            '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M8 12.5l2.5 2.5L16 9"></path></svg>',
        error:
            '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="9" y1="9" x2="15" y2="15"></line><line x1="15" y1="9" x2="9" y2="15"></line></svg>',
        info:
            '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="11" x2="12" y2="16"></line><circle cx="12" cy="8" r="0.5" fill="currentColor"></circle></svg>',
        warn:
            '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l10 18H2L12 3z"></path><line x1="12" y1="10" x2="12" y2="14"></line><circle cx="12" cy="17" r="0.5" fill="currentColor"></circle></svg>'
    };

    const ICON_SOUND_ON =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5L6 9H3v6h3l5 4V5z"></path><path d="M15.5 8.5a5 5 0 0 1 0 7"></path></svg>';
    const ICON_SOUND_OFF =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5L6 9H3v6h3l5 4V5z"></path><line x1="22" y1="9" x2="16" y2="15"></line><line x1="16" y1="9" x2="22" y2="15"></line></svg>';

    // The per-type labels announced by screen readers (never rely on color
    // alone) live in config.labels; see above.

    /* ------------------------------------------------------------------ */
    /* Sound (Web Audio API, no audio files)                                */
    /* ------------------------------------------------------------------ */

    // Note sequences per type: {f: frequency Hz, at: offset s, d: duration s}
    const TONES = {
        success: [{ f: 523.25, at: 0, d: 0.11 }, { f: 783.99, at: 0.12, d: 0.14 }],
        error:   [{ f: 311.13, at: 0, d: 0.12 }, { f: 233.08, at: 0.13, d: 0.16 }],
        info:    [{ f: 587.33, at: 0, d: 0.14 }],
        warn:    [{ f: 466.16, at: 0, d: 0.10 }, { f: 466.16, at: 0.14, d: 0.10 }]
    };
    const TONE_GAIN = 0.05; // fixed low volume

    const soundState = {
        ctx: null,
        memMuted: false,   // fallback when sessionStorage is blocked
        unlockBound: false
    };

    function isSoundMuted() {
        try {
            return window.sessionStorage.getItem(MUTE_STORAGE_KEY) === "1";
        } catch (e) {
            return soundState.memMuted;
        }
    }

    function setSoundMuted(muted) {
        soundState.memMuted = !!muted;
        try {
            window.sessionStorage.setItem(MUTE_STORAGE_KEY, muted ? "1" : "0");
        } catch (e) {
            /* private mode or blocked storage: keep it in memory only */
        }
        refreshMuteButtons();
    }

    function getAudioContext() {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        if (!soundState.ctx) {
            soundState.ctx = new AC();
        }
        if (soundState.ctx.state === "suspended") {
            soundState.ctx.resume().catch(function () { /* autoplay blocked: ignore */ });
        }
        return soundState.ctx;
    }

    // Best-effort unlock: the user's first interaction activates the AudioContext.
    function bindAutoplayUnlock() {
        if (soundState.unlockBound) return;
        soundState.unlockBound = true;
        const unlock = function () {
            getAudioContext();
            document.removeEventListener("pointerdown", unlock, true);
            document.removeEventListener("keydown", unlock, true);
        };
        document.addEventListener("pointerdown", unlock, true);
        document.addEventListener("keydown", unlock, true);
    }

    function playTone(type) {
        if (!config.sound || isSoundMuted()) return;
        try {
            const ctx = getAudioContext();
            if (!ctx || ctx.state !== "running") return; // autoplay still blocked

            const now = ctx.currentTime;
            TONES[type].forEach(function (note) {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = "sine";
                osc.frequency.value = note.f;

                const start = now + note.at;
                const end = start + note.d;
                gain.gain.setValueAtTime(0.0001, start);
                gain.gain.linearRampToValueAtTime(TONE_GAIN, start + 0.01);
                gain.gain.exponentialRampToValueAtTime(0.0001, end);

                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(start);
                osc.stop(end + 0.02);
            });
        } catch (e) {
            /* sound is best-effort: never fail the toast because of audio */
        }
    }

    function muteButtonState(btn) {
        const muted = isSoundMuted();
        btn.innerHTML = muted ? ICON_SOUND_OFF : ICON_SOUND_ON;
        btn.setAttribute("aria-pressed", muted ? "true" : "false");
        const label = muted ? config.labels.unmute : config.labels.mute;
        btn.setAttribute("aria-label", label);
        btn.title = label;
    }

    function refreshMuteButtons() {
        const buttons = document.querySelectorAll(".toasteur-mute");
        for (let i = 0; i < buttons.length; i++) {
            muteButtonState(buttons[i]);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Screen-reader announcements (persistent live regions)               */
    /* ------------------------------------------------------------------ */

    const liveRegions = { polite: null, assertive: null };

    // Created once, before the first toast (configure() runs in the block's
    // OnReady), so the regions already exist when content changes. Screen
    // readers ignore live regions that appear together with their content.
    function ensureLiveRegions() {
        if (!document.body) return;
        ["polite", "assertive"].forEach(function (politeness) {
            const existing = liveRegions[politeness];
            if (existing && document.body.contains(existing)) return;
            const region = document.createElement("div");
            region.className = "toasteur-sr-only toasteur-live";
            region.setAttribute("aria-live", politeness);
            region.setAttribute("aria-atomic", "true");
            if (politeness === "assertive") region.setAttribute("role", "alert");
            document.body.appendChild(region);
            liveRegions[politeness] = region;
        });
    }

    function announce(type, title, message) {
        ensureLiveRegions();
        const region = liveRegions[type === "error" ? "assertive" : "polite"];
        if (!region) return;
        const text = config.labels[type] + ": " + (title ? title + ". " : "") + message;
        // Clear first, then write a moment later: re-announcing an identical
        // text (deduplication) must still be a detectable change.
        region.textContent = "";
        window.setTimeout(function () { region.textContent = text; }, 50);
    }

    /* ------------------------------------------------------------------ */
    /* Per-position state                                                   */
    /* ------------------------------------------------------------------ */

    const containers = {}; // position -> HTMLElement
    const registry = {};   // position -> Map(dedupKey -> record)
    const queues = {};     // position -> Array(options)

    function getContainer(position) {
        const cached = containers[position];
        if (cached && document.body.contains(cached)) {
            return cached;
        }

        let container = document.querySelector(".toasteur-container." + position);
        if (!container) {
            container = document.createElement("div");
            container.className = "toasteur-container " + position;
            container.setAttribute("role", "region");
            container.setAttribute("aria-label", config.labels.notificationsRegion);
            document.body.appendChild(container);
        }

        containers[position] = container;
        if (!registry[position]) registry[position] = new Map();
        if (!queues[position]) queues[position] = [];
        return container;
    }

    function visibleCount(container) {
        return container.querySelectorAll(".toasteur-notification:not(.toasteur-exit)").length;
    }

    function dedupKey(options) {
        return options.type + "\u0001" + (options.title || "") + "\u0001" + options.message;
    }

    /* ------------------------------------------------------------------ */
    /* Timer with real pause (hover, keyboard focus, tab visibility)       */
    /* ------------------------------------------------------------------ */

    function createTimer(callback, duration) {
        let timeoutId = null;
        let startedAt = 0;
        let remaining = duration;
        let done = false;

        function start() {
            if (done || timeoutId !== null || remaining <= 0) return;
            startedAt = Date.now();
            timeoutId = window.setTimeout(function () {
                done = true;
                callback();
            }, remaining);
        }

        function pause() {
            if (done || timeoutId === null) return;
            window.clearTimeout(timeoutId);
            timeoutId = null;
            remaining -= Date.now() - startedAt;
        }

        function cancel() {
            done = true;
            if (timeoutId !== null) {
                window.clearTimeout(timeoutId);
                timeoutId = null;
            }
        }

        function remainingTime() {
            if (done) return 0;
            if (timeoutId === null) return remaining;
            return Math.max(0, remaining - (Date.now() - startedAt));
        }

        return { start: start, pause: pause, cancel: cancel, remaining: remainingTime };
    }

    /*
     * Pause reasons per toast: "hover", "focus" and "hidden" (tab in the
     * background). The timer pauses when the first reason enters and only
     * resumes when the last one leaves; hover and visibilitychange do not
     * trample each other. The toasteur-paused class also pauses the progress
     * bar (animation-play-state in the CSS), keeping everything in sync.
     */

    const activeRecords = new Set(); // records with an active timer

    function pauseFor(record, reason) {
        if (record.dismissed || !record.timer) return;
        const wasEmpty = record.pauseReasons.size === 0;
        record.pauseReasons.add(reason);
        if (wasEmpty) {
            record.timer.pause();
            record.element.classList.add("toasteur-paused");
        }
    }

    function resumeFor(record, reason) {
        if (record.dismissed || !record.timer) return;
        record.pauseReasons.delete(reason);
        if (record.pauseReasons.size === 0) {
            record.timer.start();
            record.element.classList.remove("toasteur-paused");
        }
    }

    // Distinguishes keyboard focus (Tab) from focus left behind by a mouse
    // click: only the former should pause the toast (WCAG, timed content).
    // A click focuses the button but without :focus-visible; pausing in that
    // case would leave the toast frozen after the mouse leaves, until focus
    // moved somewhere else on the page.
    function isKeyboardFocus(el) {
        try {
            return el.matches(":focus-visible");
        } catch (e) {
            return true; // browser without :focus-visible: always pausing is the safe side
        }
    }

    // Single global listener: pauses/resumes every active toast with the tab's
    // visibility. Registered when the script loads.
    document.addEventListener("visibilitychange", function () {
        const hidden = document.visibilityState === "hidden";
        activeRecords.forEach(function (record) {
            if (hidden) {
                pauseFor(record, "hidden");
            } else {
                // Browsers do not reliably honor animation-play-state applied
                // while the page is hidden: the bar's animation clock can keep
                // advancing by wall time, and its stale animationend would
                // dismiss the toast the moment the user returns. On resume,
                // rebuild the bar from the timer's remaining time (negative
                // animation-delay renders it at the right fraction); replacing
                // the animation also cancels the stale animationend.
                if (record.progressBar && record.timer && !record.dismissed) {
                    const remaining = record.timer.remaining();
                    const elapsed = Math.max(0, record.currentDuration - remaining);
                    restartAnimation(record.progressBar, record.currentDuration, elapsed);
                }
                resumeFor(record, "hidden");
            }
        });
    });

    /* ------------------------------------------------------------------ */
    /* Progress bar                                                         */
    /* ------------------------------------------------------------------ */

    function createProgress(duration) {
        const track = document.createElement("div");
        track.className = "toasteur-progress";
        track.setAttribute("aria-hidden", "true");

        const bar = document.createElement("div");
        bar.className = "toasteur-progress-bar";
        bar.style.animationDuration = duration + "ms";
        track.appendChild(bar);
        return { track: track, bar: bar };
    }

    function restartAnimation(el, duration, elapsed) {
        el.style.animation = "none";
        void el.offsetWidth; // force a reflow to restart the animation
        el.style.animation = "";
        el.style.animationDuration = duration + "ms";
        // Negative delay renders the animation mid-flight (visibility resync);
        // always set it so a resync delay never leaks into a later restart.
        el.style.animationDelay = elapsed ? -elapsed + "ms" : "0ms";
    }

    /* ------------------------------------------------------------------ */
    /* Dismissal and queue                                                  */
    /* ------------------------------------------------------------------ */

    function dismiss(record) {
        if (record.dismissed) return;
        record.dismissed = true;

        if (record.timer) record.timer.cancel();
        if (record.key) registry[record.position].delete(record.key);
        activeRecords.delete(record);

        // If keyboard focus is still inside this toast, return it to where it
        // was before the toast took it; otherwise removing the element would
        // drop focus on <body> and a keyboard user would lose their place.
        if (record.previousFocus && record.element.contains(document.activeElement)) {
            try {
                record.previousFocus.focus({ preventScroll: true });
            } catch (e) {
                /* the previous element may be gone; nothing to restore */
            }
            record.previousFocus = null;
        }

        record.element.classList.add("toasteur-exit");
        window.setTimeout(function () {
            if (record.element.parentNode) {
                record.element.parentNode.removeChild(record.element);
            }
            processQueue(record.position);
        }, EXIT_ANIMATION_MS + 50);
    }

    function processQueue(position) {
        const queue = queues[position];
        if (!queue || queue.length === 0) return;
        const container = getContainer(position);
        while (queue.length > 0 && visibleCount(container) < config.maxVisible) {
            renderToast(queue.shift());
        }
    }

    /* ------------------------------------------------------------------ */
    /* Deduplication                                                        */
    /* ------------------------------------------------------------------ */

    function bump(record, duration) {
        record.count += 1;
        record.badge.textContent = "\u00D7" + record.count;
        record.badge.classList.add("toasteur-count-visible");

        if (record.timer) record.timer.cancel();
        if (duration > 0) {
            record.timer = createTimer(function () { dismiss(record); }, duration);
            record.currentDuration = duration;
            activeRecords.add(record);
            // Only starts when no pause reasons are active (e.g. a bump with
            // the tab hidden or with the mouse over the toast).
            if (record.pauseReasons.size === 0) {
                record.timer.start();
            }
            if (record.progressBar) {
                restartAnimation(record.progressBar, duration);
            }
        } else {
            // Promoted to persistent (duration <= 0): drop the timer, the
            // active-record tracking and the progress bar; otherwise the old
            // bar would keep animating and its animationend would dismiss a
            // toast that is now meant to stay until closed manually.
            record.timer = null;
            record.pauseReasons.clear();
            record.element.classList.remove("toasteur-paused");
            activeRecords.delete(record);
            if (record.progressBar) {
                const track = record.progressBar.parentNode;
                if (track && track.parentNode) {
                    track.parentNode.removeChild(track);
                }
                record.progressBar = null;
            }
        }

        record.element.classList.remove("toasteur-pulse");
        void record.element.offsetWidth;
        record.element.classList.add("toasteur-pulse");
        // Re-announce: the event happened again, screen-reader users should know.
        announce(record.type, record.title, record.message);
        // No sound on reinforcement: avoids repeated tones on bursts of identical events.
    }

    /* ------------------------------------------------------------------ */
    /* Toast creation                                                       */
    /* ------------------------------------------------------------------ */

    function renderToast(options) {
        const container = getContainer(options.position);

        const toast = document.createElement("div");
        toast.className = "toasteur-notification " + options.type + " toasteur-theme-" + config.theme;
        // No aria-live on the toast itself: the announcement goes through the
        // persistent live regions (see announce()). The visible toast stays a
        // plain, navigable group with its own type label for screen readers.
        toast.setAttribute("role", "group");

        const icon = document.createElement("span");
        icon.className = "toasteur-icon";
        icon.innerHTML = ICONS[options.type];

        const srType = document.createElement("span");
        srType.className = "toasteur-sr-only";
        srType.textContent = config.labels[options.type] + ": ";

        const textContainer = document.createElement("div");
        textContainer.className = "toasteur-text-container";

        if (options.title) {
            const titleEl = document.createElement("p");
            titleEl.className = "toasteur-title";
            titleEl.textContent = options.title;
            textContainer.appendChild(titleEl);
        }

        const contentEl = document.createElement("p");
        contentEl.className = "toasteur-content";
        contentEl.appendChild(srType);
        contentEl.appendChild(document.createTextNode(options.message));
        textContainer.appendChild(contentEl);

        const badge = document.createElement("span");
        badge.className = "toasteur-count";

        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.className = "toasteur-close";
        closeBtn.setAttribute("aria-label", config.labels.close);
        closeBtn.innerHTML =
            '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"></line><line x1="18" y1="6" x2="6" y2="18"></line></svg>';

        toast.appendChild(icon);
        toast.appendChild(textContainer);
        toast.appendChild(badge);

        // Mute button: only when sound is enabled for the application.
        if (config.sound) {
            const muteBtn = document.createElement("button");
            muteBtn.type = "button";
            muteBtn.className = "toasteur-mute";
            muteButtonState(muteBtn);
            muteBtn.addEventListener("click", function (event) {
                event.stopPropagation();
                setSoundMuted(!isSoundMuted());
            });
            toast.appendChild(muteBtn);
        }

        toast.appendChild(closeBtn);

        const record = {
            element: toast,
            type: options.type,
            title: options.title,
            message: options.message,
            position: options.position,
            key: options.allowDuplicate ? null : options.key,
            count: 1,
            badge: badge,
            timer: null,
            progressBar: null,
            currentDuration: 0,
            pauseReasons: new Set(),
            previousFocus: null,
            dismissed: false
        };

        if (options.duration > 0) {
            record.timer = createTimer(function () { dismiss(record); }, options.duration);
            record.currentDuration = options.duration;
            activeRecords.add(record);

            if (options.showProgressBar) {
                const progress = createProgress(options.duration);
                record.progressBar = progress.bar;
                toast.appendChild(progress.track);
                // The bar is the source of truth for dismissal: the CSS
                // animation runs on the compositor and is time-accurate,
                // unlike setTimeout, which can lag when the main thread is
                // busy. When the bar finishes, dismiss immediately; the timer
                // remains as fallback (and is the only mechanism when there is
                // no bar). dismiss is idempotent, so both firing has no double
                // effect. Guard: never dismiss from animationend while paused;
                // a bar clock that drifted while the tab was hidden must not
                // close a toast whose timer still holds remaining time.
                progress.bar.addEventListener("animationend", function (event) {
                    if (event.animationName === "toasteur-progress" && record.pauseReasons.size === 0) {
                        dismiss(record);
                    }
                });
            }

            toast.addEventListener("mouseenter", function () {
                pauseFor(record, "hover");
            });
            toast.addEventListener("mouseleave", function () {
                resumeFor(record, "hover");
            });
            toast.addEventListener("focusin", function (event) {
                if (isKeyboardFocus(event.target)) {
                    pauseFor(record, "focus");
                }
            });
            toast.addEventListener("focusout", function () {
                resumeFor(record, "focus");
            });
        }

        closeBtn.addEventListener("click", function (event) {
            event.stopPropagation();
            dismiss(record);
        });

        if (typeof options.onClick === "function") {
            toast.classList.add("toasteur-clickable");
            // Keyboard operable: focusable, and Enter/Space activate it like a click.
            toast.setAttribute("tabindex", "0");
            const activate = function () {
                options.onClick();
                dismiss(record);
            };
            toast.addEventListener("click", activate);
            toast.addEventListener("keydown", function (event) {
                if (event.target !== toast) return; // let the inner buttons handle their own keys
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    activate();
                }
            });
        }

        if (record.key) {
            registry[options.position].set(record.key, record);
        }
        container.appendChild(toast);

        // The timer starts after the toast is inserted into the DOM, which is
        // when the bar's animation actually begins; minimizing drift between
        // the two. A toast created while the tab is in the background is born
        // paused and only starts counting when visibility returns.
        if (record.timer) {
            if (document.visibilityState === "hidden") {
                pauseFor(record, "hidden");
            } else {
                record.timer.start();
            }
        }

        announce(options.type, options.title, options.message);

        // Keyboard focus (opt-in, config.focusOnError): only error toasts move
        // focus to their close button, and only when the application enables
        // it; moving focus without a user request is a change of context
        // (WCAG 3.2), and the assertive announcement already reaches
        // screen-reader users. success/info/warn never take focus.
        // Guard: never steal focus from active typing; if the user is inside
        // an input, textarea, select or contenteditable, yanking focus away
        // mid-keystroke would be worse than the problem this solves. The
        // previously focused element is saved so dismiss() can return focus
        // there instead of dropping it on <body>. preventScroll avoids an
        // extra, possibly disorienting jump if the toast is already visible.
        if (config.focusOnError && options.type === "error") {
            const active = document.activeElement;
            const isTyping = active && (
                active.tagName === "INPUT" ||
                active.tagName === "TEXTAREA" ||
                active.tagName === "SELECT" ||
                active.isContentEditable
            );
            if (!isTyping) {
                record.previousFocus = (active && active !== document.body) ? active : null;
                try {
                    closeBtn.focus({ preventScroll: true });
                } catch (e) {
                    closeBtn.focus();
                }
            }
        }

        playTone(options.type);
        return toast;
    }

    /* ------------------------------------------------------------------ */
    /* Public API                                                           */
    /* ------------------------------------------------------------------ */

    /**
     * Application-level configuration. Call once, in the Toast block's OnReady.
     * Omitted or empty fields keep the current value. Invalid values are
     * ignored with a console warning (never an exception): this runs in the
     * Layout, so throwing here would break every screen of the application.
     * labels: partial object with accessibility labels (success, error, info,
     * warn, close, mute, unmute, notificationsRegion); omitted or empty keys
     * keep the English default.
     */
    function configure(options) {
        options = options || {};
        const isSet = function (value) { return value !== undefined && value !== null && value !== ""; };
        const warn = function (message) { console.warn("Toasteur: " + message + " Keeping the current value."); };

        ensureLiveRegions();

        if (isSet(options.theme)) {
            const theme = String(options.theme).trim();
            if (THEMES.indexOf(theme) === -1) {
                warn("invalid theme '" + theme + "'. Expected: " + THEMES.join(", ") + ".");
            } else {
                config.theme = theme;
            }
        }

        if (isSet(options.maxVisible)) {
            const max = Number(options.maxVisible);
            if (isNaN(max) || max < 1) {
                warn("invalid maxVisible '" + options.maxVisible + "', expected an integer >= 1.");
            } else {
                config.maxVisible = Math.floor(max);
            }
        }

        if (isSet(options.maxQueued)) {
            const maxQ = Number(options.maxQueued);
            if (isNaN(maxQ) || maxQ < 0) {
                warn("invalid maxQueued '" + options.maxQueued + "', expected an integer >= 0.");
            } else {
                config.maxQueued = Math.floor(maxQ);
            }
        }

        if (isSet(options.defaultDuration)) {
            const dur = Number(options.defaultDuration);
            if (isNaN(dur)) {
                warn("invalid defaultDuration '" + options.defaultDuration + "'.");
            } else {
                config.defaultDuration = dur;
            }
        }

        if (options.sound === true || options.sound === false) {
            config.sound = options.sound;
            if (config.sound) {
                bindAutoplayUnlock();
            }
        }

        if (options.focusOnError === true || options.focusOnError === false) {
            config.focusOnError = options.focusOnError;
        }

        if (options.labels && typeof options.labels === "object") {
            Object.keys(config.labels).forEach(function (key) {
                const value = options.labels[key];
                if (typeof value === "string" && value.trim() !== "") {
                    config.labels[key] = value.trim();
                }
            });
            // Containers that already exist update their region label; the
            // buttons of future toasts read config.labels at creation time.
            Object.keys(containers).forEach(function (position) {
                if (containers[position]) {
                    containers[position].setAttribute("aria-label", config.labels.notificationsRegion);
                }
            });
        }
    }

    /**
     * Shows a toast.
     * @param {Object} options
     * @param {string}  options.type            - success | error | info | warn (required)
     * @param {string}  options.message         - main text (required)
     * @param {string}  [options.title]         - optional title; when empty, it is not rendered
     * @param {string}  [options.position]      - top-right (default) | top-left | top-center |
     *                                            bottom-right | bottom-left
     * @param {number}  [options.duration]      - ms until auto-dismiss; 0 or negative = persistent;
     *                                            omitted = the configuration's defaultDuration
     * @param {boolean} [options.showProgressBar] - default true; auto-dismiss progress bar
     * @param {boolean} [options.allowDuplicate]  - default false; true disables deduplication for this toast
     * @param {Function} [options.onClick]        - callback when the toast body is clicked
     * @returns {HTMLElement|null} the toast element, or null when it was queued
     */
    function show(options) {
        options = options || {};

        const normalized = {
            type: String(options.type || "").trim(),
            message: String(options.message || "").trim(),
            title: String(options.title || "").trim(),
            position: String(options.position || "top-right").trim(),
            duration:
                options.duration === undefined || options.duration === null || options.duration === ""
                    ? config.defaultDuration
                    : Number(options.duration),
            showProgressBar: options.showProgressBar !== false,
            allowDuplicate: options.allowDuplicate === true,
            onClick: options.onClick
        };

        if (TYPES.indexOf(normalized.type) === -1) {
            throw new Error("Toasteur: invalid type '" + normalized.type + "'. Expected: " + TYPES.join(", ") + ".");
        }
        if (!normalized.message) {
            throw new Error("Toasteur: message is required.");
        }
        if (POSITIONS.indexOf(normalized.position) === -1) {
            throw new Error("Toasteur: invalid position '" + normalized.position + "'. Expected: " + POSITIONS.join(", ") + ".");
        }
        if (isNaN(normalized.duration)) {
            throw new Error("Toasteur: invalid duration.");
        }

        const container = getContainer(normalized.position);
        normalized.key = dedupKey(normalized);

        // Deduplication: an identical visible message reinforces instead of duplicating
        if (!normalized.allowDuplicate) {
            const existing = registry[normalized.position].get(normalized.key);
            if (existing && !existing.dismissed) {
                bump(existing, normalized.duration);
                return existing.element;
            }
        }

        // Visible limit: the excess goes to the queue, deduplicated (an
        // identical message already waiting is not queued twice) and bounded
        // (maxQueued per position), so a toast raised in a loop cannot flood
        // the screen for minutes after the burst.
        if (visibleCount(container) >= config.maxVisible) {
            const queue = queues[normalized.position];
            if (!normalized.allowDuplicate && queue.some(function (q) { return q.key === normalized.key && !q.allowDuplicate; })) {
                return null;
            }
            if (queue.length >= config.maxQueued) {
                console.warn("Toasteur: queue full for position '" + normalized.position + "' (maxQueued = " + config.maxQueued + "), toast dropped.");
                return null;
            }
            queue.push(normalized);
            return null;
        }

        return renderToast(normalized);
    }

    const api = { show: show, configure: configure };

    TYPES.forEach(function (type) {
        api[type] = function (message, title, options) {
            const merged = Object.assign({}, options || {}, {
                type: type,
                message: message,
                title: title
            });
            return show(merged);
        };
    });

    window.Toasteur = api;
})(window, document);
