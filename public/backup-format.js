// One document can hold 21 million body characters across its current and
// historical versions, plus 500,000 reference characters. JSON can use six
// bytes per character. Reserve room for metadata and the preview request.
export const backupRequestLimit = 130_000_000;
export const backupFileLimit = backupRequestLimit - 1_000;
export const backupVolumeTarget = 50_000_000;
