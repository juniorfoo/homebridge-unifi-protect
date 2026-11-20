/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * Shared fMP4/avcC test bytes for media stream tests (Main profile SPS bytes match avcC header).
 */

/** Minimal Main 3.1 SPS NAL payload (profile/level bytes match avcC 77 / 31). */
export const TEST_H264_MAIN31_SPS = Buffer.from([ 0x67, 0x4D, 0, 0x1F, 0x96, 0x54, 0x05, 0x01, 0xED, 0x80 ]);

export const TEST_H264_MAIN_PPS = Buffer.from([ 0x68, 0xCE, 0x38, 0x80 ]);

/** SPS with profile_idc / level_idc bytes matching the given avcC header fields. */
export function testH264SpsForProfileLevel(profileIdc: number, levelIdc: number): Buffer {

  return Buffer.from([ 0x67, profileIdc, 0, levelIdc, 0x96, 0x54, 0x05, 0x01, 0xED, 0x80 ]);
}

