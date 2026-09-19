package com.engorg.inkpad

import android.app.Activity
import android.graphics.Color
import android.view.View
import android.view.ViewGroup
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * Edge-to-edge helpers. Apps targeting Android 15 (targetSdk 35) draw behind the system bars
 * (the clock / notification / battery status bar and the nav bar) whether they ask to or not,
 * so any floating chrome laid out at the very top would sit UNDER the status bar. These helpers
 * push that chrome back down by the real inset, and keep the canvas itself full-bleed.
 *
 * Calling [ViewCompat.setOnApplyWindowInsetsListener] and returning the insets un-consumed means
 * sibling views still receive them — so a top bar and a scroll body can each claim their own edge.
 */
object SystemBars {
    /** Go edge-to-edge and match the bar icon color to the theme (dark icons on light backgrounds). */
    fun setup(activity: Activity, lightBackground: Boolean) {
        val w = activity.window
        WindowCompat.setDecorFitsSystemWindows(w, false)
        @Suppress("DEPRECATION")
        run { w.statusBarColor = Color.TRANSPARENT; w.navigationBarColor = Color.TRANSPARENT }
        WindowInsetsControllerCompat(w, w.decorView).apply {
            isAppearanceLightStatusBars = lightBackground
            isAppearanceLightNavigationBars = lightBackground
        }
    }

    private fun topInset(insets: WindowInsetsCompat) =
        insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()).top

    private fun bottomInset(insets: WindowInsetsCompat) =
        insets.getInsets(WindowInsetsCompat.Type.systemBars()).bottom

    /** Push this view's top margin below the status bar, keeping [baseGapPx] of breathing room. */
    fun marginTopBelowStatusBar(view: View, baseGapPx: Int) {
        ViewCompat.setOnApplyWindowInsetsListener(view) { v, insets ->
            (v.layoutParams as? ViewGroup.MarginLayoutParams)?.let {
                val want = topInset(insets) + baseGapPx
                if (it.topMargin != want) { it.topMargin = want; v.requestLayout() }
            }
            insets
        }
        ViewCompat.requestApplyInsets(view)
    }

    /** Add the status-bar inset on top of this view's existing top padding. */
    fun padTopForStatusBar(view: View) {
        val base = view.paddingTop
        ViewCompat.setOnApplyWindowInsetsListener(view) { v, insets ->
            v.setPadding(v.paddingLeft, base + topInset(insets), v.paddingRight, v.paddingBottom)
            insets
        }
        ViewCompat.requestApplyInsets(view)
    }

    /** Add the navigation-bar inset on top of this view's existing bottom padding. */
    fun padBottomForNavBar(view: View) {
        val base = view.paddingBottom
        ViewCompat.setOnApplyWindowInsetsListener(view) { v, insets ->
            v.setPadding(v.paddingLeft, v.paddingTop, v.paddingRight, base + bottomInset(insets))
            insets
        }
        ViewCompat.requestApplyInsets(view)
    }
}
