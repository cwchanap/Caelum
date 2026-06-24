pub const GAME_DAY_SECONDS: f64 = 1_200.0;
pub const MINUTES_PER_DAY: u16 = 1_440;

pub fn scaled_delta(delta_seconds: f64, speed: u8) -> f64 {
    delta_seconds.max(0.0) * f64::from(speed)
}

pub fn day_index(time_seconds: f64) -> u32 {
    (time_seconds.max(0.0) / GAME_DAY_SECONDS).floor() as u32
}

pub fn clock_minutes(time_seconds: f64) -> u16 {
    let day_time = time_seconds.max(0.0) % GAME_DAY_SECONDS;
    ((day_time / GAME_DAY_SECONDS) * f64::from(MINUTES_PER_DAY)).floor() as u16
}
