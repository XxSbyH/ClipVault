use std::io::Cursor;

use image::{
    codecs::jpeg::JpegEncoder, imageops::FilterType, DynamicImage, GenericImageView, ImageEncoder,
};

use crate::{
    errors::{AppError, AppResult},
    models::ImageCompression,
};

const ORIGINAL_LIMIT_BYTES: usize = 500 * 1024;
const LARGE_IMAGE_LIMIT_BYTES: usize = 5 * 1024 * 1024;
const MAX_IMAGE_WIDTH: u32 = 1920;
const MAX_IMAGE_HEIGHT: u32 = 1080;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessedImage {
    pub bytes: Vec<u8>,
    pub original_size: u64,
    pub compressed_size: u64,
    pub width: u32,
    pub height: u32,
    pub mime_type: String,
}

pub fn process_image_bytes(
    bytes: &[u8],
    compression: ImageCompression,
) -> AppResult<ProcessedImage> {
    let original_size = bytes.len() as u64;
    let image = image::load_from_memory(bytes)
        .map_err(|err| AppError::from(format!("failed to decode image: {err}")))?;
    let (width, height) = image.dimensions();

    if should_keep_original(bytes.len(), compression) {
        return Ok(ProcessedImage {
            bytes: bytes.to_vec(),
            original_size,
            compressed_size: original_size,
            width,
            height,
            mime_type: detect_input_mime_type(bytes).to_string(),
        });
    }

    let quality = compression_quality(bytes.len(), compression).unwrap_or(85);
    let resized = resize_inside(image, MAX_IMAGE_WIDTH, MAX_IMAGE_HEIGHT);
    let (width, height) = resized.dimensions();
    let output = encode_jpeg(&resized, quality)?;
    let compressed_size = output.len() as u64;
    Ok(ProcessedImage {
        bytes: output,
        original_size,
        compressed_size,
        width,
        height,
        mime_type: "image/jpeg".to_string(),
    })
}

pub fn compression_quality(size: usize, compression: ImageCompression) -> Option<u8> {
    match compression {
        ImageCompression::Original => None,
        ImageCompression::High if size < ORIGINAL_LIMIT_BYTES => None,
        ImageCompression::Medium if size < ORIGINAL_LIMIT_BYTES => None,
        ImageCompression::High if size < LARGE_IMAGE_LIMIT_BYTES => Some(85),
        ImageCompression::High => Some(75),
        ImageCompression::Medium => Some(75),
    }
}

fn should_keep_original(size: usize, compression: ImageCompression) -> bool {
    compression_quality(size, compression).is_none()
}

pub fn encode_rgba_png(rgba: &[u8], width: u32, height: u32) -> AppResult<Vec<u8>> {
    let mut output = Vec::new();
    image::codecs::png::PngEncoder::new(&mut output)
        .write_image(rgba, width, height, image::ExtendedColorType::Rgba8)
        .map_err(|err| AppError::from(format!("failed to encode clipboard image: {err}")))?;
    Ok(output)
}

fn resize_inside(image: DynamicImage, max_width: u32, max_height: u32) -> DynamicImage {
    if image.width() <= max_width && image.height() <= max_height {
        image
    } else {
        image.resize(max_width, max_height, FilterType::Lanczos3)
    }
}

fn encode_jpeg(image: &DynamicImage, quality: u8) -> AppResult<Vec<u8>> {
    let mut output = Cursor::new(Vec::new());
    let rgb = image.to_rgb8();
    JpegEncoder::new_with_quality(&mut output, quality)
        .encode_image(&rgb)
        .map_err(|err| AppError::from(format!("failed to encode compressed image: {err}")))?;
    Ok(output.into_inner())
}

fn detect_input_mime_type(bytes: &[u8]) -> &'static str {
    match bytes {
        [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, ..] => "image/png",
        [0xFF, 0xD8, 0xFF, ..] => "image/jpeg",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::ImageFormat;

    fn one_pixel_png() -> Vec<u8> {
        let image = DynamicImage::new_rgba8(1, 1);
        let mut output = Cursor::new(Vec::new());
        image.write_to(&mut output, ImageFormat::Png).unwrap();
        output.into_inner()
    }

    #[test]
    fn keeps_small_images_original() {
        let input = one_pixel_png();
        let processed = process_image_bytes(&input, ImageCompression::High).unwrap();

        assert_eq!(processed.bytes, input);
        assert_eq!(processed.width, 1);
        assert_eq!(processed.height, 1);
        assert_eq!(processed.mime_type, "image/png");
    }

    #[test]
    fn chooses_quality_by_size_and_setting() {
        assert_eq!(
            compression_quality(400 * 1024, ImageCompression::High),
            None
        );
        assert_eq!(
            compression_quality(600 * 1024, ImageCompression::High),
            Some(85)
        );
        assert_eq!(
            compression_quality(6 * 1024 * 1024, ImageCompression::High),
            Some(75)
        );
        assert_eq!(
            compression_quality(600 * 1024, ImageCompression::Medium),
            Some(75)
        );
        assert_eq!(
            compression_quality(6 * 1024 * 1024, ImageCompression::Original),
            None
        );
    }

    #[test]
    fn encodes_rgba_clipboard_image_to_png() {
        let png = encode_rgba_png(&[255, 0, 0, 255], 1, 1).unwrap();
        let processed = process_image_bytes(&png, ImageCompression::High).unwrap();

        assert_eq!(processed.width, 1);
        assert_eq!(processed.height, 1);
    }
}
