pub const WALK_SECONDS_PER_TILE: f64 = 20.0;

/// Salt for the deterministic Student school-site pick.
pub const SCHOOL_SALT: u64 = 1;
/// Salt for the deterministic day-off optional-outing pick.
pub const OPTIONAL_SALT: u64 = 2;

pub fn numeric_id_suffix(id: &str) -> usize {
    id.rsplit_once('-')
        .and_then(|(_, suffix)| suffix.parse::<usize>().ok())
        .unwrap_or(1)
}

/// Canonical Students are every 10th ID (sim-010, sim-020, ...). Only fresh
/// move-ins consult this; a restored citizen's durable routine is authoritative.
pub fn is_student_id(id: &str) -> bool {
    numeric_id_suffix(id).is_multiple_of(10)
}

/// The canonical shift templates gameplay mints (`shift_template_for_id`);
/// persistence rejects any other value instead of migrating it.
pub fn is_canonical_shift_template(template: &str) -> bool {
    matches!(template, "standard" | "early" | "late" | "offPeak")
}

/// Deterministic per-citizen per-day jitter source (SplitMix64 finalizer over
/// the id suffix, day, and salt) — no `rand` dependency.
pub fn stable_daily_seed(id: &str, day: u32, salt: u64) -> u64 {
    let mut x =
        numeric_id_suffix(id) as u64 ^ u64::from(day).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ salt;
    x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^ (x >> 31)
}

/// One day in seven is a citizen's recurring day off.
pub fn is_day_off(citizen_id: &str, day: u32) -> bool {
    day % 7 == (numeric_id_suffix(citizen_id) as u32 % 7)
}

pub fn shift_template_for_id(id: &str) -> Option<&'static str> {
    let suffix = numeric_id_suffix(id);
    if suffix.is_multiple_of(10) {
        return None;
    }

    let worker_ordinal = suffix - (suffix / 10);
    match (worker_ordinal - 1) % 10 {
        0..=6 => Some("standard"),
        7 => Some("early"),
        8 => Some("late"),
        _ => Some("offPeak"),
    }
}

pub fn departure_minute_for_sim(sim_id: &str, template: &str, direction: &str) -> u16 {
    let (start, end) = match (template, direction) {
        ("standard", "outbound") => (420, 540),
        ("standard", "return") => (1_020, 1_140),
        ("early", "outbound") => (330, 420),
        ("early", "return") => (900, 990),
        ("late", "outbound") => (600, 690),
        ("late", "return") => (1_170, 1_260),
        ("offPeak", "outbound") => (780, 870),
        ("offPeak", "return") => (1_080, 1_170),
        _ => (420, 540),
    };
    let span = end - start;
    // Take the modulo on the full `usize` suffix, then narrow. Casting to `u16` first
    // would truncate suffixes > u16::MAX before the modulo, silently shifting the jitter
    // distribution for very large sim ordinals. The modulo result is always <= span
    // (<= 120), so the final `as u16` cannot truncate.
    let jitter = (numeric_id_suffix(sim_id) % usize::from(span + 1)) as u16;
    start + jitter
}

/// Student school windows: outbound 07:30–08:30, return 15:00–16:00.
pub fn student_departure_minute(sim_id: &str, direction: &str) -> u16 {
    let (start, end) = match direction {
        "outbound" => (450, 510),
        _ => (900, 960),
    };
    let span = end - start;
    let jitter = (numeric_id_suffix(sim_id) % usize::from(span + 1)) as u16;
    start + jitter
}

/// Optional-outing departure minute in 11:00–15:00, deterministic per
/// (citizen, day).
pub fn optional_departure_minute(sim_id: &str, day: u32) -> u16 {
    660 + (stable_daily_seed(sim_id, day, OPTIONAL_SALT) % 241) as u16
}

pub fn trip_deadline_seconds(scheduled_time: f64) -> f64 {
    scheduled_time + 900.0
}
