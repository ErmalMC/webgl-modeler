/**
 * Blender-style keyboard numeric entry during a modal drag: typing a
 * digit locks the value to keyboard input instead of mouse movement.
 * Digits append, '-' toggles sign, '.' adds a decimal point, Backspace
 * removes the last character (clearing the buffer back to empty falls
 * back to mouse control). Enter/Escape are NOT handled here — those stay
 * exactly what they already are for each tool (confirm/cancel the whole
 * operation), matching Blender's own behavior where Escape during
 * numeric entry cancels the operation entirely rather than just clearing
 * the typed number.
 *
 * Shared by every drag tool that has a single scalar to type (Bevel
 * width, Scale factor, Extrude's face-mode distance, Move's
 * axis-constrained offset) rather than reimplementing digit
 * accumulation four times.
 */
export class NumericEntry {
    private buffer = '';
    private isActive = false;

    get active(): boolean {
        return this.isActive;
    }

    /** The typed value so far, or null if the buffer is empty or not yet a valid number (e.g. just "-" or "."). */
    get value(): number | null {
        if (this.buffer === '' || this.buffer === '-' || this.buffer === '.' || this.buffer === '-.') return null;
        const n = Number(this.buffer);
        return Number.isNaN(n) ? null : n;
    }

    /** What's been typed so far, for showing in a status message. */
    get displayText(): string {
        return this.buffer;
    }

    /**
     * Handles one keydown. Returns true if it consumed the key — the
     * caller should stop processing that key further (skip mouse-driven
     * updates, skip any other meaning it might have). Returns false for
     * anything numeric entry doesn't care about, so the caller falls back
     * to its normal handling.
     */
    handleKey(e: KeyboardEvent): boolean {
        const digitMatch = /^(Digit|Numpad)([0-9])$/.exec(e.code);
        if (digitMatch) {
            this.isActive = true;
            this.buffer += digitMatch[2];
            e.preventDefault();
            return true;
        }

        if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
            this.isActive = true;
            this.buffer = this.buffer.startsWith('-') ? this.buffer.slice(1) : '-' + this.buffer;
            e.preventDefault();
            return true;
        }

        if (e.code === 'Period' || e.code === 'NumpadDecimal') {
            this.isActive = true;
            if (!this.buffer.includes('.')) this.buffer += '.';
            e.preventDefault();
            return true;
        }

        if (e.code === 'Backspace' && this.isActive) {
            this.buffer = this.buffer.slice(0, -1);
            if (this.buffer === '' || this.buffer === '-') this.isActive = false;
            e.preventDefault();
            return true;
        }

        return false;
    }

    /** Resets to inactive with an empty buffer — call when a modal operation starts or finishes. */
    reset(): void {
        this.buffer = '';
        this.isActive = false;
    }
}
