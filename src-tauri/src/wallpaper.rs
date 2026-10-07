use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperTheme {
    scheme: &'static str,
    colors: ThemeColors,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThemeColors {
    bg: String,
    panel: String,
    panel2: String,
    elevated: String,
    line: String,
    line_strong: String,
    text: String,
    muted: String,
    accent: String,
    accent_text: String,
    accent_hover: String,
    accent_soft: String,
    danger: String,
    success: String,
    warm: String,
    shadow: String,
}

#[cfg(target_os = "windows")]
struct CachedWallpaper {
    path: std::path::PathBuf,
    modified: std::time::SystemTime,
    length: u64,
    theme: Option<WallpaperTheme>,
}

#[cfg(target_os = "windows")]
static WINDOWS_WALLPAPER_CACHE: std::sync::OnceLock<std::sync::Mutex<Option<CachedWallpaper>>> =
    std::sync::OnceLock::new();

#[tauri::command]
pub async fn wallpaper_theme() -> Result<Option<WallpaperTheme>, String> {
    #[cfg(target_os = "windows")]
    {
        return tauri::async_runtime::spawn_blocking(sample_windows_wallpaper)
            .await
            .map_err(|error| error.to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    Ok(None)
}

#[cfg(target_os = "windows")]
fn sample_windows_wallpaper() -> Result<Option<WallpaperTheme>, String> {
    use std::{ffi::c_void, path::PathBuf};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SystemParametersInfoW, SPI_GETDESKWALLPAPER,
    };

    let mut path = vec![0u16; 32_768];
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETDESKWALLPAPER,
            path.len() as u32,
            path.as_mut_ptr().cast::<c_void>(),
            0,
        )
    };
    if ok == 0 {
        return Err("Windows could not read the current wallpaper.".into());
    }
    let end = path
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(path.len());
    if end == 0 {
        return Ok(None);
    }
    let path = PathBuf::from(String::from_utf16_lossy(&path[..end]));
    let metadata = std::fs::metadata(&path)
        .map_err(|_| "Windows wallpaper image is unavailable.".to_string())?;
    if metadata.len() > 64 * 1024 * 1024 {
        return Err("Windows wallpaper image is larger than 64 MB.".into());
    }
    let modified = metadata
        .modified()
        .map_err(|_| "Windows wallpaper modification time is unavailable.".to_string())?;
    let length = metadata.len();
    let cache = WINDOWS_WALLPAPER_CACHE.get_or_init(|| std::sync::Mutex::new(None));
    // Keep this guard through decoding so overlapping polls cannot decode in parallel.
    let mut cached = cache
        .lock()
        .map_err(|_| "Windows wallpaper cache is unavailable.".to_string())?;
    if let Some(current) = cached.as_ref() {
        if current.path == path && current.modified == modified && current.length == length {
            return Ok(current.theme.clone());
        }
    }

    let mut reader = image::ImageReader::open(&path)
        .map_err(|_| "Windows wallpaper image is unavailable.".to_string())?;
    reader = reader
        .with_guessed_format()
        .map_err(|_| "Windows wallpaper format is unsupported.".to_string())?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16_384);
    limits.max_image_height = Some(16_384);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|_| "Windows wallpaper could not be decoded.".to_string())?;
    let thumbnail = image.thumbnail(96, 96).to_rgb8();
    let theme = palette(&thumbnail);
    *cached = Some(CachedWallpaper {
        path,
        modified,
        length,
        theme: theme.clone(),
    });
    Ok(theme)
}

#[cfg(target_os = "windows")]
fn palette(image: &image::RgbImage) -> Option<WallpaperTheme> {
    if image.is_empty() {
        return None;
    }
    let pixels: Vec<[f32; 3]> = image
        .pixels()
        .map(|p| [p[0] as f32, p[1] as f32, p[2] as f32])
        .collect();
    let average = pixels
        .iter()
        .fold([0.0; 3], |mut sum, pixel| {
            for index in 0..3 {
                sum[index] += pixel[index];
            }
            sum
        })
        .map(|value| value / pixels.len() as f32);
    let luminance = relative_luminance(average);
    let dark = luminance < 0.46;
    let bg = mix(
        average,
        if dark { [0.0; 3] } else { [255.0; 3] },
        if dark { 0.58 } else { 0.70 },
    );
    let panel = mix(
        bg,
        if dark { [255.0; 3] } else { [0.0; 3] },
        if dark { 0.055 } else { 0.035 },
    );
    let panel2 = mix(
        bg,
        if dark { [255.0; 3] } else { [0.0; 3] },
        if dark { 0.10 } else { 0.075 },
    );
    let elevated = mix(
        bg,
        if dark { [255.0; 3] } else { [0.0; 3] },
        if dark { 0.16 } else { 0.13 },
    );
    let accent_seed = pixels
        .iter()
        .copied()
        .max_by(|a, b| colorfulness(*a).total_cmp(&colorfulness(*b)))
        .unwrap_or(average);
    let accent = ensure_contrast(accent_seed, panel, 3.2);
    let accent_text = if contrast([250.0; 3], accent) >= contrast([18.0; 3], accent) {
        [250.0; 3]
    } else {
        [18.0; 3]
    };
    let text = if dark {
        [242.0, 245.0, 240.0]
    } else {
        [29.0, 32.0, 28.0]
    };
    let muted = mix(text, bg, 0.38);
    let line = mix(text, bg, 0.79);
    let line_strong = mix(text, bg, 0.61);
    Some(WallpaperTheme {
        scheme: if dark { "dark" } else { "light" },
        colors: ThemeColors {
            bg: hex(bg),
            panel: hex(panel),
            panel2: hex(panel2),
            elevated: hex(elevated),
            line: hex(line),
            line_strong: hex(line_strong),
            text: hex(text),
            muted: hex(muted),
            accent: hex(accent),
            accent_text: hex(accent_text),
            accent_hover: hex(mix(accent, accent_text, 0.12)),
            accent_soft: hex(mix(accent, bg, 0.72)),
            danger: if dark { "#f2a0a8" } else { "#9d2f3e" }.into(),
            success: if dark { "#9bd39b" } else { "#356c3b" }.into(),
            warm: if dark { "#edbe72" } else { "#925118" }.into(),
            shadow: if dark {
                "rgba(0, 0, 0, .42)"
            } else {
                "rgba(25, 28, 24, .18)"
            }
            .into(),
        },
    })
}

#[cfg(target_os = "windows")]
fn mix(a: [f32; 3], b: [f32; 3], amount: f32) -> [f32; 3] {
    std::array::from_fn(|index| a[index] * (1.0 - amount) + b[index] * amount)
}

#[cfg(target_os = "windows")]
fn colorfulness(color: [f32; 3]) -> f32 {
    color.iter().copied().fold(f32::MIN, f32::max) - color.iter().copied().fold(f32::MAX, f32::min)
}

#[cfg(target_os = "windows")]
fn relative_luminance(color: [f32; 3]) -> f32 {
    let linear = color.map(|component| {
        let value = component / 255.0;
        if value <= 0.04045 {
            value / 12.92
        } else {
            ((value + 0.055) / 1.055).powf(2.4)
        }
    });
    linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
}

#[cfg(target_os = "windows")]
fn contrast(a: [f32; 3], b: [f32; 3]) -> f32 {
    let (light, dark) = if relative_luminance(a) > relative_luminance(b) {
        (a, b)
    } else {
        (b, a)
    };
    (relative_luminance(light) + 0.05) / (relative_luminance(dark) + 0.05)
}

#[cfg(target_os = "windows")]
fn ensure_contrast(mut color: [f32; 3], background: [f32; 3], minimum: f32) -> [f32; 3] {
    let target = if relative_luminance(background) > 0.35 {
        [0.0; 3]
    } else {
        [255.0; 3]
    };
    for _ in 0..10 {
        if contrast(color, background) >= minimum {
            break;
        }
        color = mix(color, target, 0.12);
    }
    color
}

#[cfg(target_os = "windows")]
fn hex(color: [f32; 3]) -> String {
    format!(
        "#{:02x}{:02x}{:02x}",
        color[0].round() as u8,
        color[1].round() as u8,
        color[2].round() as u8
    )
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn generated_dark_wallpaper_produces_dark_accessible_theme() {
        let image = image::RgbImage::from_fn(24, 24, |x, _| {
            if x < 12 {
                image::Rgb([15, 25, 45])
            } else {
                image::Rgb([210, 75, 40])
            }
        });
        let theme = palette(&image).unwrap();
        assert_eq!(theme.scheme, "dark");
        assert!(theme.colors.bg.starts_with('#'));
        assert_ne!(theme.colors.accent, theme.colors.bg);
    }

    #[test]
    fn generated_light_wallpaper_produces_light_theme() {
        let image = image::RgbImage::from_pixel(24, 24, image::Rgb([235, 220, 190]));
        assert_eq!(palette(&image).unwrap().scheme, "light");
    }
}
