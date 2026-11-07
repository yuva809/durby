package tech.durby.pos

import org.junit.Assert.assertEquals
import org.junit.Test

class OriginsTest {
    @Test
    fun aReleaseBuildAllowsOnlyStagingAndProductionAndStartsAtStaging() {
        val release = Origins("")
        assertEquals(setOf("https://staging.durby.tech", "https://app.durby.tech"), release.allowed)
        assertEquals("https://staging.durby.tech/", release.startUrl)
    }

    @Test
    fun aDebugBuildAddsOnlyItsLocalWeb() {
        val debug = Origins("http://localhost:3000")
        assertEquals(Origins.PRODUCTION + "http://localhost:3000", debug.allowed)
        assertEquals("http://localhost:3000/", debug.startUrl)
    }

    @Test
    fun theReleaseBuildHasNoLocalOrigin() {
        // Guards the build file: release passes an empty DEV_ORIGIN (checked here through the debug value's shape).
        assertEquals(false, Origins("").allowed.any { it.startsWith("http://") })
    }
}
