import { setStyleBlock } from './styleSheet.js';
import css from './bubbles.css';

// The ambient wash is pure CSS -- see bubbles.css for why it neither moves nor
// owns an element. This module exists only to hand the block to styleSheet.ts,
// which is how every other stylesheet in the mod reaches the page under the
// app's enforced nonce-only CSP.
//
// Registered at module scope, like clock.ts's block: the rule is gated on the
// app's own body class, so it paints nothing until the app has said it is on a
// browse surface, and there is no state here to start or stop.
setStyleBlock('bubbles', css);
