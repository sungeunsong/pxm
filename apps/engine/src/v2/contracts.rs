//! V2 runtime contracts
//!
//! These contracts map directly to the BPM design document.
//! Keep these constraints strict; do not weaken semantics for convenience.

/// Required behavior contract for edge-first routing.
pub const CONTRACT_EDGE_OWNS_CONDITION: &str =
    "Routing must evaluate edge.condition and edge.is_default, not gateway-local condition fields.";

/// Required behavior contract for gateway semantics.
pub const CONTRACT_GATEWAY_SEMANTICS: &str =
    "Gateway runtime must support XOR/AND/OR fork and join semantics with token-aware coordination.";

/// Required behavior contract for concurrency.
pub const CONTRACT_INSTANCE_LOCK: &str =
    "Each instance mutation must be protected by instance lock/lease before token/context updates.";
