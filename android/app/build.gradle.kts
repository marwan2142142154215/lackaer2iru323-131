plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "id.acefleet.guard"
    // 36 = Android 16, cocok dengan build-tools 36.0.0 yang sudah terpasang.
    compileSdk = 36

    defaultConfig {
        applicationId = "id.acefleet.guard"
        // Android 10 (29) -> Android 16 (36). Semua API baru dicek dengan
        // Build.VERSION / @RequiresApi, tidak ada class yang butuh versi lebih baru.
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"

        // Alamat server broker. WAJIB HTTPS (TLS) - plaintext ditolak di kode.
        buildConfigField("String", "DEFAULT_WS_URL", "\"${project.findProperty("fleetWsUrl") ?: "wss://fleet.example.my.id/ws/v1/device"}\"")
        buildConfigField(
            "String",
            "DEFAULT_PAIR_URL",
            "\"${project.findProperty("fleetPairUrl") ?: "https://fleet.example.my.id/api/enroll/pair"}\"",
        )
        buildConfigField("String", "PROTOCOL", "\"fleetguard.v1\"")
    }

    // Keystore produksi. -PfleetStoreFile=<path> dipakai hanya kalau file-nya
    // benar-benar ada.
    val fleetKeystore: File? = project.findProperty("fleetStoreFile")
        ?.toString()
        ?.let { file(it) }
        ?.takeIf { it.isFile }

    // Release TIDAK BOLEH diam-diam ditandatangani debug. Kalau begitu, APK
    // terlihat seperti rilis padahal tidak bisa di-upgrade: Android menolak
    // upgrade bila sertifikat berubah, dan DPC tidak bisa di-uninstall.
    // Efeknya seluruh unit harus di-wipe & provisioning ulang. Jadi build
    // berhenti, kecuali operator benar-benar meminta mode smoke-test.
    val allowDebugSignedRelease =
        (project.findProperty("fleetAllowDebugSigningRelease")?.toString() ?: "false")
            .toBoolean()

    signingConfigs {
        if (fleetKeystore != null) {
            create("fleet") {
                // Signing key produksi: simpan di luar repo!
                storeFile = fleetKeystore
                storePassword = project.findProperty("fleetStorePassword")?.toString() ?: ""
                keyAlias = project.findProperty("fleetKeyAlias")?.toString() ?: "guard"
                keyPassword = project.findProperty("fleetKeyPassword")?.toString() ?: ""
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = if (fleetKeystore != null) {
                signingConfigs.getByName("fleet")
            } else if (allowDebugSignedRelease) {
                logger.lifecycle(
                    "[fleet] PERINGATAN: release ditandatangani DEBUG karena " +
                        "-PfleetAllowDebugSigningRelease=true. Smoke-test saja, " +
                        "JANGAN dipakai produksi.",
                )
                signingConfigs.getByName("debug")
            } else {
                // Sengaja TIDAK melempar error di sini. Blok buildTypes dievaluasi
                // pada configuration phase, jadi melempar dari sini membuat
                // assembleDebug ikut gagal. Penjaga yang benar dipasang lewat
                // taskGraph.whenReady di bawah - dia hanya menyala kalau ada task
                // release yang benar-benar dijadwalkan.
                signingConfigs.getByName("debug")
            }
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    // Penjaga release ditandatangani debug.whenReady berjalan setelah graf task
    // terbentuk tapi sebelum eksekusi, jadi hanya menyala kalau release benar
    //-benar dibangun. Ini yang membuat assembleDebug tetap bisa jalan tanpa
    // keystore, sementara assembleRelease tetap gagal keras.
    if (fleetKeystore == null && !allowDebugSignedRelease) {
        gradle.taskGraph.whenReady {
            val buildsRelease = allTasks.any { it.name.contains("Release") }
            if (buildsRelease) {
                throw GradleException(
                    "Keystore produksi tidak ditemukan, sehingga release tidak bisa " +
                        "ditandatangani dengan benar.\n" +
                        "Build dihentikan agar tidak menghasilkan APK 'release' yang " +
                        "sebenarnya bertanda tangan debug.\n" +
                        "Alasannya: Android menolak upgrade bila sertifikat berubah, dan " +
                        "sebagai Device Owner Guard tidak bisa di-uninstall - satu " +
                        "tanda tangan salah berarti seluruh unit harus di-wipe ulang.\n\n" +
                        "Cara benar (jalankan dari folder android/):\n" +
                        "  -PfleetStoreFile=..\\keystore\\guard-release.jks " +
                        "-PfleetStorePassword=<pw> " +
                        "-PfleetKeyAlias=guard -PfleetKeyPassword=<pw>\n\n" +
                        "Kalau memang hanya mau smoke-test, tambahkan:\n" +
                        "  -PfleetAllowDebugSigningRelease=true",
                )
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
        freeCompilerArgs = freeCompilerArgs + "-opt-in=kotlinx.coroutines.ExperimentalCoroutinesApi"
    }
    buildFeatures {
        buildConfig = true
    }
    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}")
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    // LifecycleService: CameraX hanya bisa di-bind ke LifecycleOwner.
    implementation("androidx.lifecycle:lifecycle-service:2.8.7")

    // Lokasi (FusedLocationProvider) - tidak butuh ACCESS_BACKGROUND_LOCATION
    // karena app berjalan sebagai foreground service bertipe 'location'.
    implementation("com.google.android.gms:play-services-location:21.3.0")

    // Kamera untuk /kamera_depan dan /kamera_belakang
    implementation("androidx.camera:camera-core:1.4.0")
    implementation("androidx.camera:camera-camera2:1.4.0")
    implementation("androidx.camera:camera-lifecycle:1.4.0")
}
