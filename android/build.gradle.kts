// Toolchain (lihat docs/06-build-apk.md):
//   Gradle 9.5  -> satu-satunya versi 9.x yang masih jalan dengan JDK 25
//                  DAN masih menyediakan internal API yang dipakai AGP.
//                  Gradle 9.6 menghapus InternalProblems -> build AGP gagal.
//   AGP 8.13.2  -> versi AGP terbaru; mendukung compileSdk 36 + Gradle 9
//   Kotlin 2.2.20 -> compiler JDK-25-safe
// Jangan naikkan Gradle ke 9.6+ kecuali AGP juga sudah diperbarui.
plugins {
    id("com.android.application") version "8.13.2" apply false
    id("org.jetbrains.kotlin.android") version "2.2.20" apply false
}
