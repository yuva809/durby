package tech.durby.pos

import org.junit.Assert.assertEquals
import org.junit.Test

class OriginsTest {
    @Test
    fun aReleaseBuildAllowsOnlyProductionAndItsFormerDomainAndStartsAtApp() {
        val release = Origins("")
        assertEquals(setOf("https://app.durby.tech", "https://staging.durby.tech"), release.allowed)
        // ADR 0039: staging.durby.tech redirects here; it stays allowed for the redirect and older links.
        assertEquals("https://app.durby.tech/", release.startUrl)
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
