//! Getting samples off the audio thread without ever making it wait.
//!
//! The capture callback runs on a realtime thread with a hard deadline of a
//! few milliseconds. Miss it and the result is a click, every time. So that
//! callback is not allowed to do any of the three things that can stall for
//! an unbounded time: take a lock, allocate, or perform I/O.
//!
//! That rules out a `Mutex<Vec<f32>>`, which is the obvious first idea. The
//! consumer could be holding the lock while the callback is due, and the
//! callback would block. What works instead is a single-producer,
//! single-consumer ring buffer, where writer and reader touch separate
//! indices and coordinate through atomics alone.
//!
//! The lock-free ring itself comes from `ringbuf` rather than being written
//! here. Concurrent data structures are the wrong place to be original — the
//! failure mode is a rare corruption that reproduces only under load. What
//! this module adds is the part that is specific to us: what happens when the
//! consumer falls behind.
//!
//! When the buffer is full, the writer discards the samples it could not fit
//! and counts them. Discarding is not a good outcome, but it is the only
//! acceptable one — the alternative is blocking the audio thread, which
//! damages every stream rather than one. The count is exposed so a stalled
//! consumer shows up as a number instead of as mysteriously bad transcripts.

use ringbuf::traits::{Consumer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// Creates a connected writer and reader over a ring holding `capacity`
/// samples.
///
/// Size it for the worst pause the consumer might take, not the average.
/// At 16 kHz, one second of headroom is 16000 samples.
pub fn ring(capacity: usize) -> (RingWriter, RingReader) {
    let (producer, consumer) = HeapRb::<f32>::new(capacity).split();
    let dropped = Arc::new(AtomicU64::new(0));

    (
        RingWriter {
            producer,
            dropped: Arc::clone(&dropped),
        },
        RingReader { consumer, dropped },
    )
}

/// The audio thread's end. Never blocks, never allocates.
pub struct RingWriter {
    producer: HeapProd<f32>,
    dropped: Arc<AtomicU64>,
}

/// The worker thread's end.
pub struct RingReader {
    consumer: HeapCons<f32>,
    dropped: Arc<AtomicU64>,
}

impl RingWriter {
    /// Writes what fits and returns how many samples had to be discarded
    /// because the reader has fallen behind. Zero is the healthy answer.
    pub fn write(&mut self, samples: &[f32]) -> usize {
        let accepted = self.producer.push_slice(samples);
        let discarded = samples.len() - accepted;

        if discarded > 0 {
            // Relaxed is right: this is a diagnostic counter, and nothing
            // else is ordered against it.
            self.dropped.fetch_add(discarded as u64, Ordering::Relaxed);
        }

        discarded
    }
}

impl RingReader {
    /// Fills as much of `out` as is available and returns how many samples
    /// were written. Returns zero rather than waiting when the ring is empty.
    pub fn read(&mut self, out: &mut [f32]) -> usize {
        self.consumer.pop_slice(out)
    }

    /// Total samples discarded since the ring was created. Nonzero means the
    /// consumer is too slow, and the transcript will have holes in it.
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn samples_come_out_in_the_order_they_went_in() {
        let (mut w, mut r) = ring(16);
        w.write(&[1.0, 2.0, 3.0]);

        let mut out = [0.0; 3];
        assert_eq!(r.read(&mut out), 3);
        assert_eq!(out, [1.0, 2.0, 3.0]);
    }

    #[test]
    fn reading_an_empty_ring_returns_nothing_rather_than_waiting() {
        let (_w, mut r) = ring(16);
        let mut out = [0.0; 4];
        assert_eq!(r.read(&mut out), 0);
    }

    #[test]
    fn a_reader_asking_for_more_than_is_there_gets_what_there_is() {
        let (mut w, mut r) = ring(16);
        w.write(&[1.0, 2.0]);

        let mut out = [0.0; 8];
        assert_eq!(r.read(&mut out), 2);
        assert_eq!(&out[..2], &[1.0, 2.0]);
    }

    #[test]
    fn nothing_is_dropped_while_the_reader_keeps_up() {
        let (mut w, mut r) = ring(64);
        let mut out = [0.0; 32];

        // Far more total samples than the ring holds, drained as we go.
        for round in 0..100 {
            let block: Vec<f32> = (0..32).map(|n| (round * 32 + n) as f32).collect();
            assert_eq!(w.write(&block), 0, "dropped on round {round}");
            assert_eq!(r.read(&mut out), 32);
            assert_eq!(out[0], (round * 32) as f32);
        }
        assert_eq!(r.dropped(), 0);
    }

    #[test]
    fn a_stalled_reader_causes_counted_drops_rather_than_a_stalled_writer() {
        let (mut w, mut r) = ring(8);

        assert_eq!(w.write(&[1.0; 8]), 0, "the ring should hold its capacity");
        // Reader has not run. This write cannot fit and must not block.
        assert_eq!(w.write(&[2.0; 5]), 5);
        assert_eq!(r.dropped(), 5);

        // What was already accepted is still intact.
        let mut out = [0.0; 8];
        assert_eq!(r.read(&mut out), 8);
        assert_eq!(out, [1.0; 8]);
    }

    #[test]
    fn drops_accumulate_across_calls() {
        let (mut w, r) = ring(4);
        w.write(&[0.0; 4]);
        w.write(&[0.0; 3]);
        w.write(&[0.0; 2]);
        assert_eq!(r.dropped(), 5);
    }

    #[test]
    fn writing_nothing_is_harmless() {
        let (mut w, r) = ring(8);
        assert_eq!(w.write(&[]), 0);
        assert_eq!(r.dropped(), 0);
    }
}
