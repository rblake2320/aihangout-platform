plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

val aihangoutBaseUrl = providers.gradleProperty("aihangoutBaseUrl")
    .orElse("https://aihangout-staging.rblake2320.workers.dev")
    .get()
if (!(aihangoutBaseUrl.startsWith("https://") ||
      aihangoutBaseUrl.matches(Regex("^http://127\\.0\\.0\\.1(:[0-9]{1,5})?(/.*)?$")))) {
    throw GradleException("aihangoutBaseUrl must be HTTPS or loopback HTTP")
}

android {
    namespace = "com.aihangout.companion"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.aihangout.companion"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "AIHANGOUT_BASE_URL", "\"$aihangoutBaseUrl\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.material)
    implementation(libs.androidx.security.crypto)
    implementation(libs.okhttp)

    testImplementation(libs.junit)
    testImplementation(libs.okhttp.mockwebserver)
    // The android.jar stub used for plain JVM unit tests makes every
    // org.json.* method throw ("not mocked") -- this is the standard,
    // well-known workaround: a real, non-Android implementation of the
    // same org.json package, scoped to the test classpath only.
    // Production code still runs against the real platform implementation
    // on an actual device/emulator; this dependency never ships in the APK.
    testImplementation(libs.org.json)
}
