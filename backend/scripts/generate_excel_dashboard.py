#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
generate_excel_dashboard.py
สร้างรายงานแดชบอร์ด Excel (.xlsx) แบบมืออาชีพสำหรับระบบ Plan Batch to Picking
โดยใช้ openpyxl
"""

import sys
import os
import json
import argparse
from datetime import datetime

import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

# Colors (Emerald & Slate Theme)
COLOR_EMERALD_DARK = "064E3B"
COLOR_EMERALD = "047857"
COLOR_EMERALD_LIGHT = "ECFDF5"
COLOR_MINT_BORDER = "A7F3D0"
COLOR_SLATE_HEADER = "F1F5F9"
COLOR_SLATE_BORDER = "CBD5E1"
COLOR_TEXT_DARK = "0F172A"
COLOR_TEXT_MUTED = "64748B"
COLOR_TEXT_EMERALD = "047857"
COLOR_ROSE_LIGHT = "FFF1F2"
COLOR_ROSE_BORDER = "FECDD3"
COLOR_TEXT_ROSE = "BE123C"
COLOR_AMBER_LIGHT = "FFFBEB"
COLOR_AMBER_BORDER = "FDE68A"
COLOR_TEXT_AMBER = "B45309"
COLOR_WHITE = "FFFFFF"

# Fonts
FONT_TITLE = Font(name="Segoe UI", size=16, bold=True, color=COLOR_EMERALD_DARK)
FONT_SUBTITLE = Font(name="Segoe UI", size=10, italic=True, color=COLOR_TEXT_MUTED)
FONT_SECTION = Font(name="Segoe UI", size=12, bold=True, color=COLOR_EMERALD_DARK)
FONT_TH = Font(name="Segoe UI", size=10, bold=True, color=COLOR_WHITE)
FONT_TH_LIGHT = Font(name="Segoe UI", size=10, bold=True, color=COLOR_TEXT_DARK)
FONT_BODY = Font(name="Segoe UI", size=10, color=COLOR_TEXT_DARK)
FONT_BODY_BOLD = Font(name="Segoe UI", size=10, bold=True, color=COLOR_TEXT_DARK)
FONT_CODE = Font(name="Consolas", size=10, color=COLOR_TEXT_DARK)
FONT_CODE_BOLD = Font(name="Consolas", size=10, bold=True, color=COLOR_TEXT_DARK)
FONT_TOTAL = Font(name="Segoe UI", size=11, bold=True, color=COLOR_EMERALD_DARK)

FONT_KPI_VAL = Font(name="Segoe UI", size=18, bold=True, color=COLOR_EMERALD_DARK)
FONT_KPI_LBL = Font(name="Segoe UI", size=9, bold=True, color=COLOR_TEXT_MUTED)
FONT_KPI_UNIT = Font(name="Segoe UI", size=9, italic=True, color=COLOR_TEXT_MUTED)

# Fills
FILL_HEADER = PatternFill(start_color=COLOR_EMERALD_DARK, end_color=COLOR_EMERALD_DARK, fill_type="solid")
FILL_HEADER_ACCENT = PatternFill(start_color=COLOR_EMERALD, end_color=COLOR_EMERALD, fill_type="solid")
FILL_KPI_BG = PatternFill(start_color=COLOR_EMERALD_LIGHT, end_color=COLOR_EMERALD_LIGHT, fill_type="solid")
FILL_SLATE_BG = PatternFill(start_color=COLOR_SLATE_HEADER, end_color=COLOR_SLATE_HEADER, fill_type="solid")
FILL_ZEBRA = PatternFill(start_color="F8FAFC", end_color="F8FAFC", fill_type="solid")
FILL_MISMATCH = PatternFill(start_color=COLOR_ROSE_LIGHT, end_color=COLOR_ROSE_LIGHT, fill_type="solid")
FILL_QTY_MISMATCH = PatternFill(start_color=COLOR_AMBER_LIGHT, end_color=COLOR_AMBER_LIGHT, fill_type="solid")
FILL_PENDING = PatternFill(start_color="F1F5F9", end_color="F1F5F9", fill_type="solid")
FILL_TOTAL = PatternFill(start_color=COLOR_EMERALD_LIGHT, end_color=COLOR_EMERALD_LIGHT, fill_type="solid")

# Non-TMS Category Fills & Fonts
FILL_CAT_IBD = PatternFill(start_color="E0F2FE", end_color="E0F2FE", fill_type="solid")     # Soft Sky Blue
FILL_CAT_RETURN = PatternFill(start_color="FEF3C7", end_color="FEF3C7", fill_type="solid")  # Soft Amber
FILL_CAT_OTHER = PatternFill(start_color="F1F5F9", end_color="F1F5F9", fill_type="solid")   # Soft Slate

FONT_CAT_IBD = Font(name="Segoe UI", size=10, bold=True, color="0369A1")
FONT_CAT_RETURN = Font(name="Segoe UI", size=10, bold=True, color="B45309")
FONT_CAT_OTHER = Font(name="Segoe UI", size=10, bold=True, color="334155")

def resolve_out_dhl_category(so="", ship_to_party="", storage_location=""):
    so_str = str(so or "").strip()
    stp = str(ship_to_party or "").strip()
    sl = str(storage_location or "").strip().upper()

    # 1. IBD: ถ้า SO ขึ้นต้นด้วย 132
    if so_str.startswith("132"):
        return "IBD"
    # 2. ส่งคืน (Return): ถ้า ShipToParty == 1200 หรือ StorageLocation ขึ้นต้นด้วย RT
    if stp == "1200" or sl.startswith("RT"):
        return "ส่งคืน"
    # 3. อื่นๆ
    return "อื่นๆ"

# Borders
THIN_SIDE = Side(border_style="thin", color=COLOR_SLATE_BORDER)
THICK_SIDE = Side(border_style="medium", color=COLOR_EMERALD)
DOUBLE_SIDE = Side(border_style="double", color=COLOR_EMERALD_DARK)

BORDER_BOX = Border(left=THIN_SIDE, right=THIN_SIDE, top=THIN_SIDE, bottom=THIN_SIDE)
BORDER_TOTAL = Border(top=THIN_SIDE, bottom=DOUBLE_SIDE)

# Alignments
ALIGN_LEFT = Alignment(horizontal="left", vertical="center")
ALIGN_CENTER = Alignment(horizontal="center", vertical="center")
ALIGN_RIGHT = Alignment(horizontal="right", vertical="center")
ALIGN_WRAP_LEFT = Alignment(horizontal="left", vertical="center", wrap_text=True)

def auto_fit_columns(ws, max_len_dict=None):
    """ปรับความกว้างคอลัมน์ให้อ่านง่ายพอดีเนื้อหา"""
    for col in ws.columns:
        col_letter = get_column_letter(col[0].column)
        max_len = 0
        for cell in col:
            val_str = str(cell.value or "")
            if "\n" in val_str:
                lines = val_str.split("\n")
                line_len = max(len(l) for l in lines)
            else:
                line_len = len(val_str)
            if line_len > max_len:
                max_len = line_len
        # Thai characters may take more space
        adjusted_width = max(max_len + 4, 12)
        if max_len_dict and col_letter in max_len_dict:
            adjusted_width = max_len_dict[col_letter]
        ws.column_dimensions[col_letter].width = min(adjusted_width, 45)

def build_dashboard_summary_sheet(ws, data, clean_date):
    """สร้าง Sheet 1: Dashboard Summary (ภาพรวมแดชบอร์ด)"""
    ws.title = "Dashboard Summary"
    ws.views.sheetView[0].showGridLines = True

    metrics = data.get("metrics", {})
    batches = data.get("batches", [])

    report_title = data.get("reportTitle")
    is_non_tms = bool(report_title and "TMS" in report_title) or bool(data.get("isNonTms"))

    # Row 2: Main Title
    ws.merge_cells("A2:J2")
    ws["A2"] = report_title or "ภาพรวมแผนการหยิบสินค้าและยอดทั้งหมดของล็อตในวันนั้น (Batch Plan)"
    ws["A2"].font = FONT_TITLE
    ws["A2"].alignment = ALIGN_LEFT

    # Row 3: Subtitle
    ws.merge_cells("A3:J3")
    thai_now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    sub_title = "ระบบติดตามและตรวจสอบข้อมูลนอกเหนือจากระบบ TMS (Non-TMS Logistics Verification)" if (report_title and "TMS" in report_title) else "ระบบติดตามและตรวจสอบการจัดสินค้า (Warehouse Picking Verification)"
    ws["A3"] = f"{sub_title} | ข้อมูลประจำวันที่: {clean_date} | สร้างเมื่อ: {thai_now}"
    ws["A3"].font = FONT_SUBTITLE
    ws["A3"].alignment = ALIGN_LEFT

    # Row 5: Section 1 - 5 Core KPIs
    ws["A5"] = "1. ยอดสรุปรายวัน"
    ws["A5"].font = FONT_SECTION

    # 5 KPI Cards (A6:B8, C6:D8, E6:F8, G6:H8, I6:J8)
    tot_car = metrics.get("totalQtyCAR", metrics.get("totalQty", 0))
    tot_pac = metrics.get("totalQtyPAC", 0)
    total_qty = metrics.get("totalQty", tot_car + tot_pac)

    kpi_defs = [
        ("A6", "B6", "A7", "B7", "A8", "B8", "ยอดรวม SO", metrics.get("totalSO", 0), "คำสั่งซื้อ (Sales Orders)"),
        ("C6", "D6", "C7", "D7", "C8", "D8", "ยอดรวม DO", metrics.get("totalDO", 0), "ใบส่งของ (Delivery Orders)"),
        ("E6", "F6", "E7", "F7", "E8", "F8", "ยอดรวม QTY", f"{total_qty:,}", "หน่วย (Total QTY)"),
        ("G6", "H6", "G7", "H7", "G8", "H8", "ยอดรวม SKU", metrics.get("totalSKU", 0), "รายการสินค้าทั้งหมด"),
        ("I6", "J6", "I7", "J7", "I8", "J8", "Trip รวมทั้งหมด", metrics.get("totalBatches", 0), "รอบจัดส่ง (Trip)"),
    ]

    for c_top1, c_top2, c_mid1, c_mid2, c_bot1, c_bot2, lbl, val, unit in kpi_defs:
        ws.merge_cells(f"{c_top1}:{c_top2}")
        ws.merge_cells(f"{c_mid1}:{c_mid2}")
        ws.merge_cells(f"{c_bot1}:{c_bot2}")

        ws[c_top1] = lbl
        ws[c_top1].font = FONT_KPI_LBL
        ws[c_top1].alignment = ALIGN_CENTER

        ws[c_mid1] = val
        ws[c_mid1].font = FONT_KPI_VAL
        ws[c_mid1].alignment = ALIGN_CENTER

        ws[c_bot1] = unit
        ws[c_bot1].font = FONT_KPI_UNIT
        ws[c_bot1].alignment = ALIGN_CENTER

        # Box border & fill
        for row in range(int(c_top1[1]), int(c_bot1[1]) + 1):
            for col_idx in [c_top1[0], c_top2[0]]:
                cell = ws[f"{col_idx}{row}"]
                cell.fill = FILL_KPI_BG
                cell.border = BORDER_BOX

    # Row 10: Section 2 - Batch Match vs Mismatch
    ws["A10"] = "2. สรุปผลการตรวจสอบล็อต (Batch Plan vs Batch Verification)"
    ws["A10"].font = FONT_SECTION

    matched_lines = metrics.get("matchedLines", 0)
    qty_mismatched_lines = metrics.get("qtyMismatchedLines", 0)
    mismatched_lines = metrics.get("mismatchedLines", 0)
    pending_lines = metrics.get("pendingLines", 0)
    total_lines = metrics.get("totalLines", 0)

    matched_qty = metrics.get("matchedQty", 0)
    qty_mismatched_qty = metrics.get("qtyMismatchedQty", 0)
    mismatched_qty = metrics.get("mismatchedQty", 0)
    pending_qty = metrics.get("pendingQty", 0)

    stats_headers = [
        "สถานะการจัดสินค้า", "จำนวนแถวรายการ", "สัดส่วนแถว (%)",
        "ยอดรวม QTY", "สัดส่วนต่อยอดคลัง (%)"
    ]
    for col_idx, h in enumerate(stats_headers, start=1):
        cell = ws.cell(row=11, column=col_idx, value=h)
        cell.font = FONT_TH
        cell.fill = FILL_HEADER_ACCENT
        cell.alignment = ALIGN_CENTER
        cell.border = BORDER_BOX

    stats_rows = [
        ("จัดตรงตามที่ระบบแนะนำ (Matched)", matched_lines, f"{(matched_lines/total_lines*100):.1f}%" if total_lines else "0%", f"{matched_qty:,}", f"{(matched_qty/total_qty*100):.1f}%" if total_qty else "0%"),
        ("จัดตรงตามระบบแนะนำแต่จำนวนไม่ตรง (Qty Mismatch)", qty_mismatched_lines, f"{(qty_mismatched_lines/total_lines*100):.1f}%" if total_lines else "0%", f"{qty_mismatched_qty:,}", f"{(qty_mismatched_qty/total_qty*100):.1f}%" if total_qty else "0%"),
        ("จัดไม่ตรงตามที่ระบบแนะนำ (Mismatched)", mismatched_lines, f"{(mismatched_lines/total_lines*100):.1f}%" if total_lines else "0%", f"{mismatched_qty:,}", f"{(mismatched_qty/total_qty*100):.1f}%" if total_qty else "0%"),
        ("รอข้อมูล SAP (Pending SAP)", pending_lines, f"{(pending_lines/total_lines*100):.1f}%" if total_lines else "0%", f"{pending_qty:,}", f"{(pending_qty/total_qty*100):.1f}%" if total_qty else "0%"),
        ("รวมทั้งหมด (Total)", total_lines, "100.0%", f"{total_qty:,}", "100.0%")
    ]

    for r_offset, r_data in enumerate(stats_rows, start=12):
        is_total = (r_offset == 16)
        is_qty_mismatch = (r_offset == 13 and qty_mismatched_lines > 0)
        is_mismatch = (r_offset == 14 and mismatched_lines > 0)
        is_pending = (r_offset == 15 and pending_lines > 0)
        for c_idx, val in enumerate(r_data, start=1):
            cell = ws.cell(row=r_offset, column=c_idx, value=val)
            if is_total:
                cell.font = FONT_BODY_BOLD
            elif is_qty_mismatch and c_idx == 1:
                cell.font = Font(name="Segoe UI", size=10, color=COLOR_TEXT_AMBER, bold=True)
            elif is_mismatch and c_idx == 1:
                cell.font = Font(name="Segoe UI", size=10, color=COLOR_TEXT_ROSE, bold=True)
            elif is_pending and c_idx == 1:
                cell.font = Font(name="Segoe UI", size=10, color=COLOR_TEXT_MUTED, bold=True)
            else:
                cell.font = FONT_BODY

            cell.alignment = ALIGN_LEFT if c_idx == 1 else ALIGN_RIGHT
            cell.border = BORDER_TOTAL if is_total else BORDER_BOX
            if is_total:
                cell.fill = FILL_TOTAL
            elif is_qty_mismatch:
                cell.fill = FILL_QTY_MISMATCH
            elif is_mismatch:
                cell.fill = FILL_MISMATCH
            elif is_pending:
                cell.fill = FILL_PENDING

    # Row 18: Section 3 - All Batches Breakdown Table
    ws["A18"] = "3. สรุปข้อมูลรอบคำสั่งซื้อทั้งหมด (All Batches Breakdown by SO)"
    ws["A18"].font = FONT_SECTION

    table_headers = [
        "ลำดับ", "เลขที่ SO", "เลขที่ DO", "สายส่ง / Trip", "ประเภท",
        "SKU", "จำนวนรวม (Total QTY)", "ตรงตามแนะนำ (QTY)", "เปลี่ยนล็อต (QTY)", "สัดส่วนตรง (%)", "สถานะ"
    ]
    for c_idx, h in enumerate(table_headers, start=1):
        cell = ws.cell(row=19, column=c_idx, value=h)
        cell.font = FONT_TH
        cell.fill = FILL_HEADER
        cell.alignment = ALIGN_CENTER
        cell.border = BORDER_BOX

    curr_row = 20
    for idx, b in enumerate(batches, start=1):
        order_type = b.get("orderType", "SO")
        so_no = b.get("soNumber") or b.get("batchCode", "-")
        do_no = b.get("doNumber") or str(b.get("doCount", "-"))
        route = b.get("route", "-")
        skus = b.get("skusCount", 0)
        b_tot_qty = b.get("totalQty", 0)
        b_match_qty = b.get("matchedQty", 0)
        b_mis_qty = b.get("mismatchedQty", 0)
        rate = b.get("matchRate", 0)
        if is_non_tms:
            cat_label = b.get("categoryLabel")
            if not cat_label:
                details = b.get("batchDetails", [])
                stp = ""
                sl = ""
                for d in details:
                    p = str(d.get("shipToParty", "")).strip()
                    l = str(d.get("storageLocation", "")).strip().upper()
                    if p == "1200" or l.startswith("RT"):
                        stp = "1200"
                        break
                cat_label = resolve_out_dhl_category(so_no, stp, sl)
            status = cat_label
        else:
            status = "ตรงตามแนะนำ" if b.get("status") == "COMPLETED" else ("เปลี่ยนล็อต" if b.get("status") == "IN_PROGRESS" else "วางแผน")

        row_vals = [idx, so_no, do_no, route, order_type, skus, b_tot_qty, b_match_qty, b_mis_qty, f"{rate}%", status]
        is_mismatch_batch = (b_mis_qty > 0)

        for c_idx, v in enumerate(row_vals, start=1):
            cell = ws.cell(row=curr_row, column=c_idx, value=v)
            cell.font = FONT_CODE if c_idx in [2, 3] else FONT_BODY
            cell.border = BORDER_BOX
            if c_idx == 1:
                cell.alignment = ALIGN_CENTER
            elif c_idx in [2, 3, 4]:
                cell.alignment = ALIGN_LEFT
            elif c_idx in [5, 10, 11]:
                cell.alignment = ALIGN_CENTER
            else:
                cell.alignment = ALIGN_RIGHT

            if c_idx in [6, 7, 8, 9]:
                cell.number_format = "#,##0"

            if is_non_tms and c_idx == 11:
                if status == "IBD":
                    cell.fill = FILL_CAT_IBD
                    cell.font = FONT_CAT_IBD
                elif status == "ส่งคืน":
                    cell.fill = FILL_CAT_RETURN
                    cell.font = FONT_CAT_RETURN
                elif status == "อื่นๆ":
                    cell.fill = FILL_CAT_OTHER
                    cell.font = FONT_CAT_OTHER
            elif is_mismatch_batch:
                cell.fill = FILL_MISMATCH
            elif curr_row % 2 == 1:
                cell.fill = FILL_ZEBRA

        curr_row += 1

    # Total Row
    total_row = curr_row
    ws.cell(row=total_row, column=1, value="รวมทั้งหมด").alignment = ALIGN_CENTER
    ws.cell(row=total_row, column=2, value=f"{len(batches)} คำสั่งซื้อ").alignment = ALIGN_LEFT
    ws.cell(row=total_row, column=6, value=metrics.get("totalSKU", 0)).number_format = "#,##0"
    ws.cell(row=total_row, column=7, value=total_qty).number_format = "#,##0"
    ws.cell(row=total_row, column=8, value=matched_qty).number_format = "#,##0"
    ws.cell(row=total_row, column=9, value=mismatched_qty).number_format = "#,##0"
    ws.cell(row=total_row, column=10, value=f"{metrics.get('matchedPct', 0)}%").alignment = ALIGN_CENTER
    ws.cell(row=total_row, column=11, value="-").alignment = ALIGN_CENTER

    for c_idx in range(1, 12):
        cell = ws.cell(row=total_row, column=c_idx)
        cell.font = FONT_TOTAL
        cell.border = BORDER_TOTAL
        cell.fill = FILL_TOTAL

    auto_fit_columns(ws, {"A": 8, "B": 16, "C": 16, "D": 22, "E": 10, "F": 10, "G": 20, "H": 18, "I": 18, "J": 14, "K": 14})

def build_so_batches_detail_sheet(ws, data, clean_date):
    """สร้าง Sheet 2: SO Batch Details (รายละเอียด Batch แยกตาม DO และ SKU)"""
    ws.title = "SO Batch Details"
    ws.views.sheetView[0].showGridLines = True

    report_title = data.get("reportTitle")
    is_non_tms = bool(report_title and "TMS" in report_title) or bool(data.get("isNonTms"))

    # Title
    ws["A2"] = "รายละเอียดข้อมูลนอกเหนือจากระบบ TMS แยกตาม DO และ SKU" if is_non_tms else "รายละเอียดเลข Batch ทั้งหมดตาม SO แยกตาม DO และย่อยตาม SKU"
    ws["A2"].font = FONT_TITLE
    ws["A3"] = f"ตรวจสอบรายการนอกเหนือจากระบบ TMS vs Batch (จาก SAP) | วันที่: {clean_date}" if is_non_tms else f"เปรียบเทียบ Plan Batch (FirstBatch จาก S3) vs Batch (จาก SAP) | วันที่: {clean_date}"
    ws["A3"].font = FONT_SUBTITLE

    if is_non_tms:
        table_headers = [
            "ลำดับ", "เลขที่ SO", "เลขที่ DO", "สายส่ง / Trip", "ปลายทาง / จังหวัด",
            "รหัสสินค้า (Material)", "ชื่อรายการสินค้า (Description)",
            "Plan Batch / FirstBatch (S3)", "Batch (SAP)", "จำนวน (QTY)", "หน่วย (Unit)", "สถานะ", "ผลการตรวจสอบ"
        ]
    else:
        table_headers = [
            "ลำดับ", "เลขที่ SO", "เลขที่ DO", "สายส่ง / Trip", "ปลายทาง / จังหวัด",
            "รหัสสินค้า (Material)", "ชื่อรายการสินค้า (Description)",
            "Plan Batch / FirstBatch (S3)", "Batch (SAP)", "จำนวน (QTY)", "หน่วย (Unit)", "ผลการตรวจสอบ"
        ]

    for c_idx, h in enumerate(table_headers, start=1):
        cell = ws.cell(row=5, column=c_idx, value=h)
        cell.font = FONT_TH
        cell.fill = FILL_HEADER
        cell.alignment = ALIGN_CENTER
        cell.border = BORDER_BOX

    details = data.get("soBatchDetails", [])
    if not details and "batches" in data:
        details = [item for b in data["batches"] for item in b.get("batchDetails", [])]

    curr_row = 6
    total_qty = 0
    total_car = 0
    total_pac = 0

    for idx, item in enumerate(details, start=1):
        so_val = item.get("so", "-")
        do_val = item.get("do", "-")
        route = item.get("route", "-")
        customer_raw = item.get("shipToFullName") or item.get("customer", "-")
        customer = customer_raw.split("/")[0].strip() if (customer_raw and "/" in customer_raw) else (customer_raw or "-")
        material = item.get("material", "-")
        item_val = item.get("item")
        if item_val:
            material = f"{material} ({item_val})"
        sku_desc = item.get("skuDescription", "-")
        plan_batch = item.get("firstBatchStr") or item.get("batchPlan", "-")
        sap_batch = item.get("sapBatch") or item.get("vrfyBatch", "-")
        qty = item.get("qty", 0)
        unit_val = (item.get("deliveryQuantityUnit") or "CAR").strip().upper() or "CAR"
        is_match = bool(item.get("match"))
        total_qty += qty
        if unit_val == "CAR":
            total_car += qty
        elif unit_val == "PAC":
            total_pac += qty

        batch_status = item.get("batchStatus") or ("MATCH" if is_match else "MISMATCH")
        if batch_status == "MATCH":
            status_text = "ตรงตามแนะนำ"
        elif batch_status == "QTY_MISMATCH":
            status_text = "จัดตรงตามแนะนำแต่จำนวนไม่ตรง"
        elif batch_status == "PENDING":
            status_text = "รอข้อมูล SAP"
        else:
            status_text = "เปลี่ยนล็อต"

        category_label = item.get("categoryLabel") or resolve_out_dhl_category(
            so_val, item.get("shipToParty"), item.get("storageLocation")
        )

        if is_non_tms:
            row_vals = [idx, so_val, do_val, route, customer, material, sku_desc, plan_batch, sap_batch, qty, unit_val, category_label, status_text]
        else:
            row_vals = [idx, so_val, do_val, route, customer, material, sku_desc, plan_batch, sap_batch, qty, unit_val, status_text]

        for c_idx, v in enumerate(row_vals, start=1):
            cell = ws.cell(row=curr_row, column=c_idx, value=v)
            cell.font = FONT_CODE if c_idx in [2, 3, 6, 8, 9] else FONT_BODY
            cell.border = BORDER_BOX

            if c_idx == 1:
                cell.alignment = ALIGN_CENTER
            elif c_idx in [2, 3, 4, 5, 6, 7, 8, 9]:
                cell.alignment = ALIGN_LEFT
            elif c_idx == 10:
                cell.alignment = ALIGN_RIGHT
                cell.number_format = "#,##0"
            elif is_non_tms and c_idx in [11, 12, 13]:
                cell.alignment = ALIGN_CENTER
            elif not is_non_tms and c_idx in [11, 12]:
                cell.alignment = ALIGN_CENTER

            status_col = 13 if is_non_tms else 12

            if is_non_tms and c_idx == 12:
                if category_label == "IBD":
                    cell.fill = FILL_CAT_IBD
                    cell.font = FONT_CAT_IBD
                elif category_label == "ส่งคืน":
                    cell.fill = FILL_CAT_RETURN
                    cell.font = FONT_CAT_RETURN
                elif category_label == "อื่นๆ":
                    cell.fill = FILL_CAT_OTHER
                    cell.font = FONT_CAT_OTHER
            elif batch_status == "QTY_MISMATCH":
                cell.fill = FILL_QTY_MISMATCH
                if c_idx in [9, status_col]:
                    cell.font = Font(name="Segoe UI", size=10, bold=True, color=COLOR_TEXT_AMBER)
            elif batch_status == "PENDING":
                cell.fill = FILL_PENDING
                if c_idx in [9, status_col]:
                    cell.font = Font(name="Segoe UI", size=10, bold=True, color=COLOR_TEXT_MUTED)
            elif not is_match and sap_batch != "-":
                cell.fill = FILL_MISMATCH
                if c_idx in [9, status_col]:
                    cell.font = Font(name="Segoe UI", size=10, bold=True, color=COLOR_TEXT_ROSE)
            elif curr_row % 2 == 1:
                cell.fill = FILL_ZEBRA

        curr_row += 1

    # Total row
    total_row = curr_row
    ws.cell(row=total_row, column=1, value="รวมทั้งหมด").alignment = ALIGN_CENTER
    ws.cell(row=total_row, column=2, value=f"{len(details)} รายการ").alignment = ALIGN_LEFT
    ws.cell(row=total_row, column=10, value=total_qty).number_format = "#,##0"
    ws.cell(row=total_row, column=10).alignment = ALIGN_RIGHT
    summary_unit_text = "รวม QTY"
    ws.cell(row=total_row, column=11, value=summary_unit_text).alignment = ALIGN_CENTER

    total_cols = 13 if is_non_tms else 12
    if is_non_tms:
        ws.cell(row=total_row, column=12, value="-").alignment = ALIGN_CENTER
        ws.cell(row=total_row, column=13, value="-").alignment = ALIGN_CENTER
    else:
        ws.cell(row=total_row, column=12, value="-").alignment = ALIGN_CENTER

    for c_idx in range(1, total_cols + 1):
        cell = ws.cell(row=total_row, column=c_idx)
        cell.font = FONT_TOTAL
        cell.border = BORDER_TOTAL
        cell.fill = FILL_TOTAL

    if is_non_tms:
        auto_fit_columns(ws, {"A": 8, "B": 16, "C": 16, "D": 20, "E": 18, "F": 16, "G": 32, "H": 26, "I": 18, "J": 14, "K": 12, "L": 14, "M": 16})
    else:
        auto_fit_columns(ws, {"A": 8, "B": 16, "C": 16, "D": 20, "E": 18, "F": 16, "G": 32, "H": 26, "I": 18, "J": 14, "K": 16, "L": 16})

def build_raw_data_sheet(ws, raw_items, clean_date):
    """สร้าง Sheet 3: Raw Data (ข้อมูลดิบ)"""
    ws.title = "Raw Data"
    ws.views.sheetView[0].showGridLines = True

    if not raw_items:
        ws["A1"] = "ไม่มีข้อมูลดิบ"
        return

    # Extract headers
    first = raw_items[0]
    keys = list(first.keys())
    # Exclude complex objects if any
    clean_keys = [k for k in keys if not isinstance(first[k], (dict, list))]

    for c_idx, k in enumerate(clean_keys, start=1):
        cell = ws.cell(row=1, column=c_idx, value=k)
        cell.font = FONT_TH
        cell.fill = FILL_HEADER
        cell.alignment = ALIGN_CENTER
        cell.border = BORDER_BOX

    for r_idx, item in enumerate(raw_items, start=2):
        for c_idx, k in enumerate(clean_keys, start=1):
            val = item.get(k, "")
            cell = ws.cell(row=r_idx, column=c_idx, value=str(val) if val is not None else "")
            cell.font = FONT_BODY
            cell.border = BORDER_BOX
            if r_idx % 2 == 1:
                cell.fill = FILL_ZEBRA

    auto_fit_columns(ws)

def main():
    parser = argparse.ArgumentParser(description="Generate Executive Excel Dashboard for Plan Batch to Picking")
    parser.add_argument("--input-json", required=True, help="Path to input JSON data file")
    parser.add_argument("--output-path", required=True, help="Path to output .xlsx file")
    parser.add_argument("--date", default="", help="Date string YYYY-MM-DD")
    args = parser.parse_args()

    if not os.path.exists(args.input_json):
        print(f"Error: Input JSON file not found at {args.input_json}", file=sys.stderr)
        sys.exit(1)

    with open(args.input_json, "r", encoding="utf-8") as f:
        data = json.load(f)

    clean_date = args.date or data.get("date") or datetime.now().strftime("%Y-%m-%d")

    wb = openpyxl.Workbook()
    # Default sheet
    ws_default = wb.active

    # Sheet 1: Dashboard Summary
    build_dashboard_summary_sheet(ws_default, data, clean_date)

    # Sheet 2: SO Batch Details
    ws_so = wb.create_sheet(title="SO Batch Details")
    build_so_batches_detail_sheet(ws_so, data, clean_date)

    # Sheet 3: Raw Data
    raw_list = data.get("rawItems", [])
    if raw_list:
        ws_raw = wb.create_sheet(title="Raw Data")
        build_raw_data_sheet(ws_raw, raw_list, clean_date)

    # Ensure output directory exists
    out_dir = os.path.dirname(os.path.abspath(args.output_path))
    os.makedirs(out_dir, exist_ok=True)

    wb.save(args.output_path)
    print(f"SUCCESS: Generated Excel dashboard report at {args.output_path}")

if __name__ == "__main__":
    main()
