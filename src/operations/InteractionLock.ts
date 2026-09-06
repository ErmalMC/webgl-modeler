/**
 * Shared mutual-exclusion lock for modal tools (Extrude, Scale, Loop Cut,
 * Bevel), all of which listen globally for keyboard/pointer events and
 * take over the viewport while active. Without this, pressing S while E's
 * drag is still active would start a second modal operation on top of
 * the first.
 */
export class InteractionLock {
    private ownerName: string | null = null;

    isLocked(): boolean {
        return this.ownerName !== null;
    }

    isHeldBy(name: string): boolean {
        return this.ownerName === name;
    }

    acquire(name: string): boolean {
        if (this.ownerName !== null) return false;
        this.ownerName = name;
        return true;
    }

    /** No-op if `name` isn't the current holder. */
    release(name: string): void {
        if (this.ownerName === name) this.ownerName = null;
    }
}
