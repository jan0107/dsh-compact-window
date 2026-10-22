window.__ModuleLoader__.load({
  id: 'dsh-compact-window',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useState, useSyncExternalStore } = React;

    const NS = 'compact-window';
    const DICT = {
      zh: {
        enter: '小窗模式',
        exit: '退出小窗',
        failed: '小窗模式切换失败',
        noWindow: '未找到 DSH 桌面窗口（请在桌面端使用）',
        pin: '置顶',
        unpin: '取消置顶',
      },
      en: {
        enter: 'Small window mode',
        exit: 'Exit small window',
        failed: 'Could not switch the window mode',
        noWindow: 'No DSH desktop window found (use the desktop app)',
        pin: 'Always on top',
        unpin: 'Stop always on top',
      },
    };

    /** Shared compact-mode state: the composer button owns it, the overlay reads it. */
    const store = {
      mode: 'normal',
      drag: false,
      pinned: true,
      veil: false,
      chrome: false,
      snapshot: 'normal|0|1|0|0',
      listeners: new Set(),
      publish() {
        const next =
          this.mode +
          '|' +
          (this.drag ? '1' : '0') +
          '|' +
          (this.pinned ? '1' : '0') +
          '|' +
          (this.veil ? '1' : '0') +
          '|' +
          (this.chrome ? '1' : '0');
        if (next === this.snapshot) return;
        this.snapshot = next;
        for (const listener of this.listeners) listener();
      },
      set(patch) {
        Object.assign(this, patch);
        this.publish();
      },
      subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
      get() {
        return this.snapshot;
      },
    };

    const subscribeStore = (listener) => store.subscribe(listener);
    const getStoreSnapshot = () => store.get();

    /** Whether the sidebar was open when compact mode was entered; restored on exit. */
    let sidebarWasExpanded = false;

    const BUTTON_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '28px',
      height: '28px',
      padding: 0,
      border: 'none',
      borderRadius: '8px',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      cursor: 'pointer',
      flex: 'none',
    };

    const NO_DRAG_CSS = [
      'html[data-compact-window] *,',
      'html[data-compact-window] *::before,',
      'html[data-compact-window] *::after{',
      '-webkit-app-region:no-drag!important;',
      'app-region:no-drag!important;',
      '}',
    ].join('');

    /**
     * Compact-mode layout: the sidebar becomes a drawer over a full-width chat.
     * The width transition (not transform) keeps the sidebar's fixed toggle anchored
     * to the viewport. The drawer starts below the Windows titlebar band so its
     * header never collides with that fixed toggle.
     */
    const COMPACT_CSS = [
      'html[data-compact-window] div:has(> [data-shell-overlay]){',
      'grid-template-columns:0 minmax(0,1fr) minmax(0,0px)!important;',
      '}',
      /* The sidebar leaves the grid flow below, so pin the other columns explicitly;
         auto-placement would otherwise push the chat into the zero-width track. */
      'html[data-compact-window] div:has(> [data-shell-overlay])>div[class*="centerCol"]{',
      'grid-column:2!important;',
      '}',
      'html[data-compact-window] div:has(> [data-shell-overlay])>div[class*="rightbarCol"]{',
      'grid-column:3!important;',
      '}',
      'html[data-compact-window] div:has(> [data-shell-overlay])>div[class*="sidebarCol"]{',
      'position:absolute;top:var(--dsh-windows-titlebar-height,0px);bottom:0;left:0;width:0;',
      'z-index:25;overflow:hidden;background:var(--dsw-specific-sidebar-fill);',
      'transition:width 220ms cubic-bezier(.22,.61,.36,1),box-shadow 220ms ease;',
      '}',
      'html[data-compact-window] div:has(> [data-shell-overlay]):not([data-sidebar-collapsed])>div[class*="sidebarCol"]{',
      'width:280px;',
      'box-shadow:8px 0 28px rgba(0,0,0,.32);',
      '}',
    ].join('');

    /**
     * Sidebar open/close gets a real transition in normal mode too. The shipped
     * rule only animates while `data-animating` is set and is disabled outright
     * under prefers-reduced-motion, which is why the sidebar usually snapped.
     *
     * The transition is always on, except while the window is being resized
     * (`data-cw-resizing`): the rightbar track is viewport-dependent, so a
     * permanent transition would make it lag behind a live window resize.
     * `data-dragging` stays excluded so dragging the sidebar width stays 1:1.
     */
    const FRAME_ANIM_CSS = [
      'html:not([data-compact-window]) div:has(> [data-shell-overlay]):not([data-dragging]):not([data-cw-resizing]):not([data-rightbar-fullscreen]):not([data-rightbar-instant]){',
      'transition:grid-template-columns 200ms cubic-bezier(.22,.61,.36,1)!important;',
      '}',
    ].join('');

    /**
     * Transition veil. It is opaque enough to hide the text reflow that happens
     * while the OS window changes width, but keeps the window silhouette readable.
     * No blur: a full-window backdrop filter has to be recomputed every frame.
     */
    const VEIL_STYLE = {
      position: 'fixed',
      inset: 0,
      pointerEvents: 'none',
      zIndex: 2147482000,
      background: 'var(--dsw-alias-bg-base)',
      opacity: 0,
      transition: 'opacity 140ms ease',
      willChange: 'opacity',
    };

    const ANIMATION_FALLBACK_MS = 240;
    const SIDEBAR_TOGGLE_WAIT_MS = 220;
    const VEIL_LEAD_MS = 100;

    const DRAG_STYLE = {
      position: 'fixed',
      top: 0,
      left: 0,
      right: '178px',
      height: '40px',
      pointerEvents: 'auto',
      cursor: 'grab',
      zIndex: 2147483000,
      background: 'transparent',
    };

    const PIN_STYLE = {
      position: 'fixed',
      top: '6px',
      right: '146px',
      width: '28px',
      height: '28px',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 0,
      border: 'none',
      borderRadius: '8px',
      pointerEvents: 'auto',
      cursor: 'pointer',
      zIndex: 2147483001,
    };

    function post(action) {
      return fetch('/compact-window', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      }).catch(() => {});
    }

    function makeButton(ctx, t) {
      return function CompactWindowButton() {
        const snapshot = useSyncExternalStore(subscribeStore, getStoreSnapshot);
        const [mode, dragFlag] = snapshot.split('|');
        const compact = mode === 'compact';
        const [busy, setBusy] = useState(false);
        const [hover, setHover] = useState(false);
        const [supported, setSupported] = useState(true);

        useEffect(() => {
          let alive = true;
          fetch('/compact-window', { headers: { accept: 'application/json' } })
            .then((response) => response.json())
            .then((state) => {
              if (!alive || !state) return;
              setSupported(state.supported !== false);
              store.set({
                mode: typeof state.mode === 'string' ? state.mode : 'normal',
                drag: state.drag === true,
                pinned: state.pinned === true,
                chrome: state.mode === 'compact',
              });
            })
            .catch(() => {});
          return () => {
            alive = false;
          };
        }, []);

        const toggle = useCallback(async () => {
          if (busy) return;
          const wasCompact = store.mode === 'compact';
          setBusy(true);
          store.set({ veil: true });
          // The pin and drag strip belong to compact mode only: drop them the
          // instant the user leaves, instead of letting them ride the grow animation.
          if (wasCompact) store.set({ chrome: false });
          let sidebarWait = 0;
          try {
            if (!wasCompact) {
              // Close the sidebar first, so it never collapses *after* the window
              // has already become small. The veil covers the reflow.
              const frame = document.querySelector('div:has(> [data-shell-overlay])');
              const expanded = frame !== null && !frame.hasAttribute('data-sidebar-collapsed');
              sidebarWasExpanded = expanded;
              if (expanded && ctx.layout && typeof ctx.layout.toggleSidebar === 'function') {
                ctx.layout.toggleSidebar();
                sidebarWait = SIDEBAR_TOGGLE_WAIT_MS;
                await new Promise((resolve) => setTimeout(resolve, sidebarWait));
              }
            }
            // Give the veil time to become opaque before the window starts moving;
            // when the sidebar just closed it has already been fading in.
            if (sidebarWait === 0) {
              await new Promise((resolve) => setTimeout(resolve, VEIL_LEAD_MS));
            }

            const response = await fetch('/compact-window', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'toggle' }),
            });
            const state = await response.json();
            if (state && typeof state.mode === 'string') {
              const animationMs = Number(state.animationMs) || ANIMATION_FALLBACK_MS;
              const apply = () =>
                store.set({
                  mode: state.mode,
                  drag: state.drag === true,
                  pinned: state.pinned === true,
                });
              if (state.mode === 'compact') {
                // Entering: the compact layout applies at once, but the strip and
                // pin only appear once the window has finished shrinking.
                apply();
                setTimeout(() => {
                  store.set({ veil: false, chrome: true });
                  setBusy(false);
                }, animationMs + 40);
              } else {
                // Exiting: keep the compact layout until the window has grown back,
                // then reopen the sidebar only if it was open when we entered.
                setTimeout(() => {
                  apply();
                  store.set({ veil: false });
                  setBusy(false);
                  if (
                    sidebarWasExpanded &&
                    ctx.layout &&
                    typeof ctx.layout.toggleSidebar === 'function'
                  ) {
                    setTimeout(() => ctx.layout.toggleSidebar(), 160);
                  }
                }, animationMs + 40);
              }
            } else {
              if (state && state.error) console.error('[compact-window]', state.error);
              store.set({ veil: false });
              setBusy(false);
            }
          } catch (error) {
            console.error('[compact-window]', error);
            store.set({ veil: false });
            setBusy(false);
          }
        }, [busy]);

        // Off Windows the host answers supported:false — there is no desktop window
        // this plugin could resize, so the control stays out of the composer.
        if (!supported) return null;

        const label = t(compact ? 'exit' : 'enter');

        return h(
          'button',
          {
            type: 'button',
            title: label,
            'aria-label': label,
            'aria-pressed': compact,
            disabled: busy,
            onClick: toggle,
            onMouseEnter: () => setHover(true),
            onMouseLeave: () => setHover(false),
            style: {
              ...BUTTON_STYLE,
              background: compact || hover ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
              color: compact
                ? 'var(--dsw-alias-brand-primary)'
                : 'var(--dsw-alias-label-secondary)',
              opacity: busy ? 0.55 : 1,
              cursor: busy ? 'default' : 'pointer',
            },
          },
          h(
            'svg',
            { width: 16, height: 16, viewBox: '0 0 24 24', 'aria-hidden': true },
            h('rect', {
              x: 3,
              y: 4,
              width: 18,
              height: 14,
              rx: 2.5,
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.8,
            }),
            h('rect', {
              x: 13,
              y: 12,
              width: 8,
              height: 6,
              rx: 1.5,
              fill: 'currentColor',
              opacity: 0.9,
            }),
          ),
        );
      };
    }

    /** Top strip that replaces the native caption drag, plus the pin toggle beside the window buttons. */
    function DragStrip({ t }) {
      const snapshot = useSyncExternalStore(subscribeStore, getStoreSnapshot);
      const [mode, dragFlag, pinnedFlag, , chromeFlag] = snapshot.split('|');
      // `layoutActive` owns the compact stylesheet and outlives the chrome: on exit
      // the layout must stay compact until the window has grown, while the strip
      // and pin disappear the moment the user clicks.
      const layoutActive = mode === 'compact' && dragFlag === '1';
      const chromeActive = layoutActive && chromeFlag === '1';
      const pinned = pinnedFlag === '1';
      const [dragging, setDragging] = useState(false);

      useEffect(() => {
        const root = document.documentElement;
        if (layoutActive) root.setAttribute('data-compact-window', '1');
        else root.removeAttribute('data-compact-window');
        return () => root.removeAttribute('data-compact-window');
      }, [layoutActive]);

      if (!chromeActive) return null;

      const finish = (event) => {
        setDragging(false);
        try {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        } catch {
          /* ignore */
        }
        post('dragEnd');
      };

      const togglePin = async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const next = !pinned;
        store.set({ pinned: next });
        try {
          const response = await fetch('/compact-window', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'pin', pinned: next }),
          });
          const state = await response.json();
          if (state && typeof state.pinned === 'boolean') store.set({ pinned: state.pinned });
        } catch {
          store.set({ pinned });
        }
      };

      return h(
        React.Fragment,
        null,
        h('div', {
          style: { ...DRAG_STYLE, cursor: dragging ? 'grabbing' : 'grab' },
          onPointerDown: (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            setDragging(true);
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              /* ignore */
            }
            post('dragStart');
          },
          onPointerUp: finish,
          onPointerCancel: finish,
        }),
        h(
          'button',
          {
            type: 'button',
            title: t(pinned ? 'unpin' : 'pin'),
            'aria-label': t(pinned ? 'unpin' : 'pin'),
            'aria-pressed': pinned,
            onClick: togglePin,
            style: {
              ...PIN_STYLE,
              background: pinned ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
              color: pinned
                ? 'var(--dsw-alias-brand-primary)'
                : 'var(--dsw-alias-label-secondary)',
            },
          },
          h(
            'svg',
            { width: 16, height: 16, viewBox: '0 0 24 24', 'aria-hidden': true },
            h('path', {
              d: 'M8 3h8v2h-1v6l3 3v2h-5v5l-1 1-1-1v-5H6v-2l3-3V5H8V3z',
              fill: 'currentColor',
            }),
          ),
        ),
      );
    }

    /** Transition veil: hides the reflow while the OS window changes size. */
    function Veil() {
      const snapshot = useSyncExternalStore(subscribeStore, getStoreSnapshot);
      const visible = snapshot.split('|')[3] === '1';
      return h('div', {
        'aria-hidden': true,
        style: {
          ...VEIL_STYLE,
          opacity: visible ? 0.88 : 0,
          transition: visible ? 'opacity 80ms ease' : 'opacity 140ms ease',
        },
      });
    }

    /**
     * Suppresses the frame track transition while the OS window is being resized.
     * The transition itself is always on (FRAME_ANIM_CSS), so a sidebar toggle is
     * deterministic; only viewport-dependent column changes need this guard.
     */
    function FrameTransitions() {
      useEffect(() => {
        const frame = document.querySelector('div:has(> [data-shell-overlay])');
        if (frame === null) return undefined;
        let timer = null;
        const onResize = () => {
          frame.setAttribute('data-cw-resizing', '1');
          if (timer !== null) clearTimeout(timer);
          timer = setTimeout(() => {
            frame.removeAttribute('data-cw-resizing');
            timer = null;
          }, 140);
        };
        window.addEventListener('resize', onResize);
        return () => {
          window.removeEventListener('resize', onResize);
          if (timer !== null) clearTimeout(timer);
          frame.removeAttribute('data-cw-resizing');
        };
      }, []);
      return null;
    }

    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICT), 'compact-window:dictionaries');
        const t = ctx.locale.bind(NS);
        const Button = makeButton(ctx, t);

        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register(
            { name: 'conversation.input.right', id: 'compact-window', order: 20 },
            Button,
          ),
        );

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'compact-window-drag', order: 70 },
            () =>
              h(
                React.Fragment,
                null,
                h('style', null, NO_DRAG_CSS),
                h('style', null, COMPACT_CSS),
                h('style', null, FRAME_ANIM_CSS),
                h(Veil),
                h(FrameTransitions),
                h(DragStrip, { t }),
              ),
          ),
        );
      },
    };
  },
});
