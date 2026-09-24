package com.engorg.inkpad

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import androidx.core.graphics.PathParser

/**
 * Vector icons drawn from path data (Material-style, 24-unit grid). Rendered to a white bitmap and
 * tinted at use via ImageView.setColorFilter, so icons stay crisp and match the theme — no text,
 * no emoji, no image files.
 */
object Icons {
    const val BACK = "M20,11H7.83l5.59,-5.59L12,4l-8,8 8,8 1.41,-1.41L7.83,13H20v-2z"
    const val UNDO = "M12.5,8c-2.65,0 -5.05,0.99 -6.9,2.6L2,7v9h9l-3.62,-3.62c1.39,-1.16 3.16,-1.88 5.12,-1.88 3.54,0 6.55,2.31 7.6,5.5l2.37,-0.78C21.08,11.03 17.15,8 12.5,8z"
    const val REDO = "M18.4,10.6C16.55,8.99 14.15,8 11.5,8c-4.65,0 -8.58,3.03 -9.96,7.22L3.9,16c1.05,-3.19 4.05,-5.5 7.6,-5.5 1.95,0 3.73,0.72 5.12,1.88L13,16h9V7l-3.6,3.6z"
    const val PEN = "M3,17.25V21h3.75L17.81,9.94l-3.75,-3.75L3,17.25zM20.71,7.04c0.39,-0.39 0.39,-1.02 0,-1.41l-2.34,-2.34c-0.39,-0.39 -1.02,-0.39 -1.41,0l-1.83,1.83 3.75,3.75 1.83,-1.83z"
    const val MARKER = "M7,14c-1.66,0 -3,1.34 -3,3 0,1.31 -1.16,2 -2,2 0.92,1.22 2.49,2 4,2 2.21,0 4,-1.79 4,-4 0,-1.66 -1.34,-3 -3,-3zM20.71,4.63l-1.34,-1.34c-0.39,-0.39 -1.02,-0.39 -1.41,0L9,12l3,3 8.71,-8.96c0.39,-0.39 0.39,-1.02 0,-1.41z"
    const val ERASER = "M16.24,3.56l4.95,4.94c0.78,0.79 0.78,2.05 0,2.84L12,20.53c-0.78,0.79 -2.05,0.79 -2.84,0L3.56,15.13c-0.78,-0.79 -0.78,-2.05 0,-2.84L13.4,3.56C14.19,2.78 15.45,2.78 16.24,3.56z"
    const val LASSO = "M3,5v4h2V5h4V3H5C3.9,3 3,3.9 3,5zM5,15H3v4c0,1.1 0.9,2 2,2h4v-2H5v-4zM19,3h-4v2h4v4h2V5c0,-1.1 -0.9,-2 -2,-2zM19,19h-4v2h4c1.1,0 2,-0.9 2,-2v-4h-2v4z"
    const val SHAPES = "M12,2l-5.5,9h11L12,2zM17.5,22c2.49,0 4.5,-2.01 4.5,-4.5S19.99,13 17.5,13 13,15.01 13,17.5 15.01,22 17.5,22zM3,21.5h8v-8H3v8z"
    const val SIZE = "M3,17h18v-2H3v2zM3,20h18v-1H3v1zM3,13h18v-3H3v3zM3,4v4h18V4H3z"
    const val BRUSH = "M18,4V3c0,-0.55 -0.45,-1 -1,-1H5C4.45,2 4,2.45 4,3v4c0,0.55 0.45,1 1,1h12c0.55,0 1,-0.45 1,-1V6h1v4H9v11c0,0.55 0.45,1 1,1h2c0.55,0 1,-0.45 1,-1v-9h8V4H18z"
    const val ZOOM_IN = "M15.5,14h-0.79l-0.28,-0.27C15.41,12.59 16,11.11 16,9.5 16,5.91 13.09,3 9.5,3S3,5.91 3,9.5 5.91,16 9.5,16c1.61,0 3.09,-0.59 4.23,-1.57l0.27,0.28v0.79l5,4.99L20.49,19l-4.99,-5zM9.5,14C7.01,14 5,11.99 5,9.5S7.01,5 9.5,5 14,7.01 14,9.5 11.99,14 9.5,14zM12,10h-2v2H9v-2H7V9h2V7h1v2h2v1z"
    const val ZOOM_OUT = "M15.5,14h-0.79l-0.28,-0.27C15.41,12.59 16,11.11 16,9.5 16,5.91 13.09,3 9.5,3S3,5.91 3,9.5 5.91,16 9.5,16c1.61,0 3.09,-0.59 4.23,-1.57l0.27,0.28v0.79l5,4.99L20.49,19l-4.99,-5zM9.5,14C7.01,14 5,11.99 5,9.5S7.01,5 9.5,5 14,7.01 14,9.5 11.99,14 9.5,14zM7,9h5v1H7z"
    const val FIT = "M7,14H5v5h5v-2H7v-3zM5,10h2V7h3V5H5v5zM17,17h-3v2h5v-5h-2v3zM14,5v2h3v3h2V5h-5z"
    const val PREV = "M15.41,7.41L14,6l-6,6 6,6 1.41,-1.41L10.83,12z"
    const val NEXT = "M10,6L8.59,7.41 13.17,12l-4.58,4.59L10,18l6,-6z"
    const val ADD = "M19,13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"
    const val EMAIL = "M20,4H4c-1.1,0 -1.99,0.9 -1.99,2L2,18c0,1.1 0.9,2 2,2h16c1.1,0 2,-0.9 2,-2V6c0,-1.1 -0.9,-2 -2,-2zM20,8l-8,5 -8,-5V6l8,5 8,-5v2z"
    const val FOLDER = "M10,4H4c-1.1,0 -1.99,0.9 -1.99,2L2,18c0,1.1 0.9,2 2,2h16c1.1,0 2,-0.9 2,-2V8c0,-1.1 -0.9,-2 -2,-2h-8l-2,-2z"
    const val FOLDER_ADD = "M20,6h-8l-2,-2H4C2.9,4 2.01,4.9 2.01,6L2,18c0,1.1 0.9,2 2,2h16c1.1,0 2,-0.9 2,-2V8c0,-1.1 -0.9,-2 -2,-2zM19,14h-3v3h-2v-3h-3v-2h3V9h2v3h3v2z"
    const val CHECK = "M9,16.17L4.83,12l-1.42,1.41L9,19 21,7l-1.41,-1.41z"
    const val CLOSE = "M19,6.41L17.59,5 12,10.59 6.41,5 5,6.41 10.59,12 5,17.59 6.41,19 12,13.41 17.59,19 19,17.59 13.41,12z"
    const val GRID = "M3,3h8v8H3zM13,3h8v8h-8zM3,13h8v8H3zM13,13h8v8h-8z"
    const val DROPLET = "M12,2l5.66,5.66c3.12,3.12 3.12,8.19 0,11.31 -3.12,3.12 -8.19,3.12 -11.31,0 -3.12,-3.12 -3.12,-8.19 0,-11.31L12,2z"
    const val BOOK = "M18,2H6C4.9,2 4,2.9 4,4v16c0,1.1 0.9,2 2,2h12c1.1,0 2,-0.9 2,-2V4C20,2.9 19.1,2 18,2zM7,4h2v8l-1,-0.75L7,12V4z"
    const val TRASH = "M6,19c0,1.1 0.9,2 2,2h8c1.1,0 2,-0.9 2,-2V7H6v12zM19,4h-3.5l-1,-1h-5l-1,1H5v2h14V4z"
    const val PALETTE = "M12,2C6.49,2 2,6.49 2,12s4.49,10 10,10c1.38,0 2.5,-1.12 2.5,-2.5 0,-0.61 -0.23,-1.2 -0.64,-1.67 -0.08,-0.1 -0.13,-0.21 -0.13,-0.33 0,-0.28 0.22,-0.5 0.5,-0.5H16c3.31,0 6,-2.69 6,-6 0,-4.96 -4.49,-9 -10,-9zM6.5,13C5.67,13 5,12.33 5,11.5S5.67,10 6.5,10 8,10.67 8,11.5 7.33,13 6.5,13zM9.5,9C8.67,9 8,8.33 8,7.5S8.67,6 9.5,6 11,6.67 11,7.5 10.33,9 9.5,9zM14.5,9c-0.83,0 -1.5,-0.67 -1.5,-1.5S13.67,6 14.5,6 16,6.67 16,7.5 15.33,9 14.5,9zM17.5,13c-0.83,0 -1.5,-0.67 -1.5,-1.5S16.67,10 17.5,10 19,10.67 19,11.5 18.33,13 17.5,13z"
    const val HOME = "M10,20v-6h4v6h5v-8h3L12,3 2,12h3v8z"
    const val PAGE = "M14,2H6C4.9,2 4.01,2.9 4.01,4L4,20c0,1.1 0.89,2 1.99,2H18c1.1,0 2,-0.9 2,-2V8l-6,-6zM13,9V3.5L18.5,9H13z"
    const val DOWNLOAD = "M19,9h-4V3H9v6H5l7,7 7,-7zM5,18v2h14v-2H5z"
    const val MORE = "M12,8c1.1,0 2,-0.9 2,-2s-0.9,-2 -2,-2 -2,0.9 -2,2 0.9,2 2,2zM12,10c-1.1,0 -2,0.9 -2,2s0.9,2 2,2 2,-0.9 2,-2 -0.9,-2 -2,-2zM12,16c-1.1,0 -2,0.9 -2,2s0.9,2 2,2 2,-0.9 2,-2 -0.9,-2 -2,-2z"
    const val SPLIT = "M3,5v14h8V5H3zM13,5v14h8V5h-8zM9,17H5V7h4v10zM19,17h-4V7h4v10z"
    const val CAST = "M1,18v3h3c0,-1.66 -1.34,-3 -3,-3zM1,14v2c2.76,0 5,2.24 5,5h2c0,-3.87 -3.13,-7 -7,-7zM1,10v2c4.97,0 9,4.03 9,9h2c0,-6.08 -4.93,-11 -11,-11zM21,3H3c-1.1,0 -2,0.9 -2,2v3h2V5h18v14h-7v2h7c1.1,0 2,-0.9 2,-2V5c0,-1.1 -0.9,-2 -2,-2z"

    fun bitmap(pathData: String, px: Int): Bitmap {
        val bmp = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
        try {
            val c = Canvas(bmp)
            val path = PathParser.createPathFromPathData(pathData)
            path.transform(Matrix().apply { setScale(px / 24f, px / 24f) })
            c.drawPath(path, Paint().apply { isAntiAlias = true; style = Paint.Style.FILL; color = Color.WHITE })
        } catch (_: Exception) { }
        return bmp
    }
}
