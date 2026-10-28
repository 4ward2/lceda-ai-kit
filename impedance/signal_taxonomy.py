#!/usr/bin/env python3
"""信号类别与差分配对的单一真相源。

为什么单独成文件：分类正则此前散在 signal_impedance.py（类别）与 impedance_validate.py
（DIFF_TAIL 差分配对）两处，口径会漂。更糟的是 DIFF_TAIL 只认 *P/*N 结尾，
在 76151 个真实网名上核对后发现它漏掉了两种最常见的写法：

    +/-    2520 对网名 / 8278 板次   (D+, D-, NVL2T2+, ETH0_MDI0+)
    P/M    360 对网名 / 2456 板次    (USB_DP/USB_DM —— USB2.0 的经典写法)

原 DIFF_TAIL 只覆盖 7376 个网名，漏掉的这些让差分样本少了一半以上，USB2 尤其被打残
（notes.txt 2026-09-18 那轮 USB2 只有 n=5）。所以配对与分类必须一起定义、一起核对。

三档受控性（controlled / conditional / uncontrolled）是本模块锁定的尺子，先于任何数字：
  controlled    —— 设计上应当控阻抗，实测若与基线无差别，说明这批板没做
  conditional   —— 是否控阻抗取决于长度/速率，实测只能描述现象，不能反推"该不该"
  uncontrolled  —— 设计上就不控，可以当基线用

类别的 se/diff 是**接口规范的目标值**（参考口径），不是本语料的实测值。二者不得混用。

自检：  py -3.11 tools/signal_taxonomy.py
"""
from __future__ import annotations

import re
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

CONTROLLED = "controlled"
CONDITIONAL = "conditional"
UNCONTROLLED = "uncontrolled"


# ---------------------------------------------------------------- 差分配对

# 每项 = (正极正则, 把正极换成负极的替换式)。按特异性排序，先匹配到的赢。
# _M 必须排在裸 M 前面，+/- 不需要分隔符。
_PAIR_FORMS: list[tuple[str, str]] = [
    (r"^(.*?)(_)(POS)$", r"\1\2NEG"),
    (r"^(.*?)(_)(PLUS)$", r"\1\2MINUS"),
    (r"^(.*?)(_)(TXP)$", r"\1\2TXN"),
    (r"^(.*?)(_)(RXP)$", r"\1\2RXN"),
    (r"^(.*?)([_\-]?)(P)$", r"\1\2N"),      # ..._P / ...-P / ...P
    (r"^(.*?)([_\-]?)(P)$", r"\1\2M"),      # DP/DM 写法
    (r"^(.*?)()(\+)$", r"\1-"),             # D+ / D-
]
_PAIR_RX = [(re.compile(p, re.I), p, r) for p, r in _PAIR_FORMS]

# 长得像差分但不是：电源轨、H 桥/推挽驱动、运放引脚、比较器。
# 这些在语料里会伪装成 P/N 或 H/L 对（PWM1P/PWM1N、OUTH/OUTL、AVDDH、COMP、VPOS）。
NOT_A_PAIR = re.compile(
    r"^(V|AV|DV|\+|-)|(^|_)(VCC|VDD|VSS|VBAT|VBUS|VREF|GND|AGND|DGND|PGND|VPOS|VNEG)"
    r"|(^|_)(PWM|HB|HBRIDGE|MOS|GATE|DRV|DRIVE|MOTOR|FAN|RELAY|COIL|BUZZ)"
    r"|(^|_)(COMP|OPA?MP|AMP_?(IN|OUT)|FB|FEEDBACK)($|_|\d)"
    # 审计补充：电流/电压检测的正负端、运放的同相反相输入、以及单字母极性名
    # （B+ 电池、L+/R+ 声道、X+/Y+ 触摸屏坐标、I+ 电流）都会伪装成差分对。
    r"|(^|_)(CS|SV|SNS|SENSE|ISNS|VSNS)[PN]$"
    r"|(^|_)(IN|OUT|INPUT|OUTPUT)([+\-]|[PN])$"
    r"|^(B|L|R|X|Y|I|P|A|M\d)[+\-]$"
    r"|^LED[+\-]$",
    re.I)


def pair_partner(net: str) -> list[str]:
    """给一个网名，返回它作为差分正极时对应的负极候选名（可能多种写法）。"""
    if not net or NOT_A_PAIR.search(net):
        return []
    out: list[str] = []
    for rx, pat, rep in _PAIR_RX:
        if rx.match(net):
            other = re.sub(pat, rep, net, flags=re.I)
            if other != net and other not in out:
                out.append(other)
    return out


def diff_nets(universe) -> set[str]:
    """从一块板的网名集合里挑出真正成对的差分网（正负两端都在集合里）。"""
    names = set(universe)
    found: set[str] = set()
    for n in names:
        for other in pair_partner(n):
            if other in names:
                found.add(n)
                found.add(other)
                break
    return found


# ---------------------------------------------------------------- 排除项

# 先于任何类别正则检查。带接口名但不走该接口电气层的网：电源轨、复位/使能/中断、
# 热插拔检测、边带控制。放进来会把该接口的中位值拖向板子的默认线宽。
# （notes.txt 2026-09-18 踩过的坑：VCC5V0_HDMI、HDMI_CEC、CSI_RST_C。）
EXCLUDE = re.compile(
    # 电源轨。AVDD/DVDD 等可以出现在任意位置（UFS_AVDD0V85 这种带接口名的电源轨）。
    r"^([+-]|V(CC|DD|BAT|BUS|IN|OUT|SYS|REF|PP|DDQ|TT)|GND|VSS|AGND|DGND|PGND|EGND"
    r"|\d+V\d*|V\d+)"
    r"|(^|_)(AVDD|AVCC|DVDD|DVCC|VDDA|VDDIO|VREF|VPP)"
    r"|(^|_)BAT([+\-]|$|_)|_BAT($|_)"
    # 控制/状态脚。RSTN/RESETN 与 HPDIN/HPDET 是审计里漏网的两种写法。
    r"|_(EN|ENABLE|RST|RSTN|RESET|RESETN|INT|IRQ|PWR|PWM|LED|CTRL|CEC|HPD|HPDIN|HPDET"
    r"|DET|DIM|WAKE|CLKREQ|PRSNT|PERST|ALERT|FAULT|OE|BIAS|SENSE|ADJ|TEST|TRIM)(_|\d*$)"
    r"|(^|_)(EN|RST|RSTN|RESET|RESETN|INT|IRQ|CEC|HPD|NRST|MRST|SHDN|STBY|SLEEP)(_|\d*$)"
    r"|(^|_)(TEMP|NTC|THERM|CURR|VOLT|ISENSE|VSENSE)(_|\d*$)"
    # 指示/执行器：这些是基线的一部分，但不该被任何接口类抓走。
    r"|(^|_)(BEEP|BUZZ|BUZZER)(\d*$|_)",
    re.I)


# ---------------------------------------------------------------- 类别表

class Klass:
    __slots__ = ("name", "rx", "se", "diff", "control", "note", "priority")

    def __init__(self, name, pattern, se=None, diff=None,
                 control=CONDITIONAL, note="", priority=50):
        self.name = name
        self.rx = re.compile(pattern, re.I)
        self.se = se
        self.diff = diff
        self.control = control
        self.note = note
        self.priority = priority


# priority 小者先匹配。凡是"接口名 + 泛化子串"的类别都必须排在泛化规则之前，
# 否则 PCIE_REFCLK_P 会被通用 CLK 规则吞掉。
CLASSES: list[Klass] = [
    # ---- 内存 ----
    Klass("DDR_DATA",
          r"(^|_)(DQ\d{1,2}|DQM\d?|[LU]DQS|[LU]DM)([_PNM+\-]|$)|DQS[_PN]?\d*"
          r"|(^|_)(DDR|LPDDR|SDRAM)\w*_?DM\d",
          se=40, diff=80, control=CONTROLLED, priority=10,
          note="DDR3/4/LPDDR 数据组；DQS 差分、DQ/DM 单端。"
               "裸 DM<n> 已移出本类：器件探针证实 DM1–DM4（合计 560 板次）是 USB 座的 D-，"
               "而全语料 DDR 颗粒只出现在 55 块板上。Data Mask 认 DQM/LDM/UDM 或带 DDR 前缀"),
    Klass("DDR_ADDR", r"(DDR|LPDDR)\d?.*_?(A\d{1,2}|BA\d|RAS|CAS|WE|CKE|ODT|CS)"
                      r"|(^|_)(RAS|CAS)_?N",
          se=40, control=CONTROLLED, priority=11,
          note="地址/命令组，与 CLK 等长匹配"),
    # 审计教训：原来的 `(^|_)CK[_]?[PN]` 把 DSI_CKN / HDMI_CKP / MIPI_CKP / CSI_CKP
    # 全吞成了 DDR 时钟。CK 这个缩写在 MIPI/TMDS 里同样常用，必须要求 DDR 前缀。
    Klass("DDR_CLK", r"(^|_)(DDR|LPDDR|SDRAM)\d?_?.{0,6}(CK|CLK)[_]?[PNM+\-]?($|_)"
                     r"|(^|_)(MEM|SD)_?CK[_]?[PN]($|_)",
          diff=80, control=CONTROLLED, priority=12,
          note="DDR 时钟差分对；CK 必须带内存前缀，否则会吞掉 MIPI/TMDS 的 CK"),

    # ---- PCIe 家族 ----
    Klass("PCIE", r"PCIE|PCI_?E|PE[TR][PN]?\d|PER[PN]\d|PET[PN]\d"
                  r"|(^|_)S\d+_[TR]X\d+[PNM+\-]|(^|_)REFCLK[_]?[PN+\-]?($|_)",
          diff=85, control=CONTROLLED, priority=15,
          note="PCIe 基础规范 85Ω±15%；产业界也大量用 100Ω"),
    # 审计教训：原来的 `(^|_)M2_` 抓到的全是 M2_IN1 / M2_OUT2 / M2_A —— 电机 2 的驱动脚。
    # M.2 插槽的网名一定带 PCIe 信号名，不会只有一个 M2_ 前缀。
    Klass("NVME", r"NVME|(^|_)M2_?(PE|PCIE|TX|RX|REFCLK|CLKREQ)|SSD_[TR]X",
          diff=85, control=CONTROLLED, priority=16,
          note="NVMe 走 PCIe 电气层，同 85Ω；M2_ 必须跟 PCIe 信号名，否则是电机 2"),
    Klass("NVLINK", r"NVLINK|(^|_)NVL\d*[TR]\d", diff=85, control=CONTROLLED, priority=17,
          note="NVIDIA NVLink 差分 85Ω；语料里以 NVL<n>T/R<lane>+/- 写法出现"),
    Klass("CXL", r"(^|_)CXL|UCIE", diff=85, control=CONTROLLED, priority=18,
          note="CXL 复用 PCIe 电气层"),
    Klass("SATA", r"SATA|(^|_)SATA_?[TR]X[PNM+\-]?", diff=100, control=CONTROLLED, priority=19,
          note="SATA 规范 100Ω±15%"),
    Klass("SAS", r"(^|_)SAS(_|\d|$)", diff=100, control=CONTROLLED, priority=20,
          note="SAS 100Ω"),

    # ---- USB 家族：先 4 再 3 再 2，否则 USB3 会被 USB2 的泛规则吞 ----
    Klass("USB4", r"USB4|THUNDERBOLT|(^|_)TBT", diff=85, control=CONTROLLED, priority=21,
          note="USB4/Thunderbolt 走 PCIe/DP 电气层，85Ω"),
    Klass("USB3", r"USB3|USB_?SS|SSTX|SSRX|(^|_)SS[TR]X[PNM+\-]|(^|_)SS(TX|RX)",
          diff=90, control=CONTROLLED, priority=22,
          note="USB 3.x SuperSpeed 差分 90Ω"),
    # 语料里 USB2 有四种写法：D+/D-、DP/DM、DP/DN、UD+/UD-。审计发现 DN（401 板）
    # 原来完全漏网，因为旧正则只写了 D[PM]。
    Klass("USB2", r"USB.*[_]?D[PMN]\d?($|_)|(^|_)U?D[_\-]?[PMN]($|_)|USBD[PMN]"
                  r"|(^|_)U?D[+\-]$|USB.*D[+\-]$"
                  r"|(^|_)USB\d?[_\-]?[PN+\-]$|^DP[+\-]$"      # USB_P / USB+ / DP+
                  r"|^D\d[+\-]$|^D\d[_\-]?[PMN]$"              # HUB 多路 D1+/D2P
                  r"|^D[PM]\d*[A-Z]?\d*$"                       # DP1/DM2/DPC/DMC/DPC1
                  r"|(^|_)HSD\d?[+\-]$|(^|_)HSD\d?[_]?[PMN]$",  # HSD0+/HSD0- 高速数据
          diff=90, control=CONTROLLED, priority=23,
          note="USB 2.0 差分 90Ω。写法全部取自器件探针确认过的真实网名："
               "D+/D-、DP/DM、DP/DN、UD+/UD-、USB_P、D1+/D2P（HUB 多路）、"
               "DP1/DM2（多路）、DPC/DMC（Type-C 侧）、HSD0+（High Speed Data）"),
    Klass("USBC_SIDEBAND", r"(^|_)(CC1|CC2|SBU1|SBU2)($|_)", control=UNCONTROLLED, priority=24,
          note="Type-C CC/SBU 边带，不控阻抗"),

    # ---- 显示 ----
    Klass("EDP", r"(^|_)EDP|E_?DP_?(TX|LANE|AUX|D\d)", diff=100, control=CONTROLLED, priority=13,
          note="eDP 主链路差分 100Ω；AUX 也是 100Ω 差分。必须早于 USB2，否则 EDP 的 DP_ 前缀会被 USB 的 D+ 规则抢走"),
    Klass("DISPLAYPORT", r"DISPLAYPORT|DPTX|DPRX|(^|_)DP_?(LANE|ML|AUX|TX|RX)\d*"
                         r"|(^|_)ML_?LANE\d",
          diff=100, control=CONTROLLED, priority=14,
          note="DisplayPort 主链路 100Ω。与 USB 的 DP(D+) 同名，靠 LANE/AUX/TX 佐证并抢在 USB2 之前，否则 DP_LANE0+ 会被判成 USB2"),
    Klass("HDMI", r"(HDMI|TMDS).*([_]?D\d|TX\d?|CLK)[_]?[PNM+\-]?($|_)|(^|_)TMDS",
          diff=100, control=CONTROLLED, priority=27,
          note="TMDS 差分 100Ω（CEC/DDC/HPD 不计入）"),
    Klass("MIPI", r"(MIPI|DSI|CSI)\d?.*(D\d|CLK|LN\d|LANE\d)[_]?[PNMB+\-]?($|_)"
                  r"|(^|_)(DSI|CSI)\d?_?(D\d|CLK)[PNM+\-]?",
          se=50, diff=100, control=CONTROLLED, priority=28,
          note="MIPI D-PHY 差分 100Ω / 单端 50Ω"),
    Klass("LVDS", r"LVDS|(^|_)[TR]X(OUT|IN)\d?[PNM+\-]$", diff=100,
          control=CONTROLLED, priority=29,
          note="LVDS 差分 100Ω"),
    Klass("VBYONE", r"V_?BY_?ONE|VBY[PN]|(^|_)VX1", diff=100, control=CONTROLLED, priority=30,
          note="V-by-One HS，100Ω"),
    Klass("RGB_LCD", r"(^|_)LCD_?(D\d{1,2}|R\d|G\d|B\d|DE|PCLK|DCLK)($|_)"
                     r"|(^|_)(HSYNC|VSYNC|DOTCLK)($|_)",
          control=UNCONTROLLED, priority=31,
          note="并行 RGB 屏接口，通常不控阻抗"),
    # 审计教训：SDI 在本语料里 100% 是 SPI 的 Serial Data In（SPI_SDI / I2S2_SDI_M0 /
    # TP_SDI / LCD_SDI），没有一例是 SDI 视频。裸 SDI 已从本类移除，交给 SPI。
    Klass("VIDEO_75", r"(^|_)(CVBS|YPBPR|SVIDEO|COMPOSITE)($|_|\d)"
                      r"|(^|_)SDI_?(IN|OUT)?\d?($|_)(?=.*(VIDEO|BNC|75))", se=75,
          control=CONTROLLED, priority=32,
          note="复合视频单端 75Ω。SDI 已剔除：语料里 SDI 全是 SPI 数据线，不是 SDI 视频"),

    # ---- 网络 ----
    Klass("ETHERNET", r"(^|_)(MDI|TRD)\d?[_]?[PNM+\-]?($|\d)|ETH\d?_?(MDI|TRD|[TR][XD])"
                      r"|(^|_)[TR]X[PNM+\-]\d?($|_)|100BASE|1000BASE|BASE_?T1",
          diff=100, control=CONTROLLED, priority=33,
          note="以太网 MDI 差分 100Ω；车载 100/1000BASE-T1 单对 100Ω"),
    Klass("SERDES_MII", r"RGMII|SGMII|QSGMII|(^|_)RMII|(^|_)GMII|XAUI|XFI|SFI",
          control=CONDITIONAL, priority=34,
          note="MII 家族：RGMII/RMII 是单端源同步（一般不控），SGMII/QSGMII 才是 100Ω 差分"),
    Klass("MDIO", r"(^|_)MDIO($|_)|(^|_)MDC($|_)", control=UNCONTROLLED, priority=35,
          note="PHY 管理总线，低速不控"),

    # ---- 转换器 / 高速采样 ----
    # 审计教训：原来的 `SYNC[_]?[PN]$` 抓到的是 DAC_SYNC_N / DAC0_SYNC_N —— DAC 的
    # 帧同步控制脚，不是 JESD204 的 SYNC~ 差分对。收紧到必须带 JESD/SYSREF。
    Klass("JESD204", r"JESD|(^|_)SYSREF[_]?[PNM+\-]?($|_)", diff=100,
          control=CONTROLLED, priority=36,
          note="JESD204B/C 串行链路 100Ω"),
    Klass("ADC", r"(^|_)(ADC|AIN|AN)\d+|ADC_?IN|(^|_)ADC($|_)", se=50, diff=100,
          control=CONDITIONAL, priority=37,
          note="高速 ADC 输入才控阻抗；低速采样链通常不控 —— 本语料两者混在一起"),
    # 审计教训：AU_DAC1P（556 板）原来漏网，因为旧正则要求 DAC\d* 后面直接是 $ 或 _，
    # 接不住带极性后缀的差分写法。
    Klass("DAC", r"(^|_)(DAC|AOUT|VOUT_?DAC)\d*[_]?[PNM+\-]?($|_)", se=50, diff=100,
          control=CONDITIONAL, priority=38,
          note="高速 DAC 输出才控阻抗；低速不控"),

    # ---- 射频 ----
    # 审计教训：GPS_TXD / BLE_RXD 是模块的串口，BT_RSTN 是复位 —— 都不是射频走线。
    # 射频网名要么是天线/RF 本身，要么模块名后面不跟数字通信信号。
    Klass("RF", r"(^|_)(ANT|ANTENNA|RFIN|RFOUT|RF)(\d*)($|_)(?!.*(TXD|RXD|RST|EN|INT|IO))"
                r"|(^|_)(WIFI|BT|BLE|2G4|NFC|LORA|GPS|GNSS|LNA|PA_?OUT)_?(ANT|RF|IN|OUT)?"
                r"(\d*)($|_)(?!.*(TXD|RXD|TX|RX|RST|EN|INT|SDA|SCL|IO))",
          se=50, control=CONTROLLED, priority=40,
          note="射频单端 50Ω（视频/天线场合可能 75Ω）；模块的串口/控制脚不计入"),

    # ---- 存储 / 中速总线 ----
    Klass("UFS", r"(^|_)UFS", diff=100, control=CONTROLLED, priority=41,
          note="UFS M-PHY 差分 100Ω"),
    # 写法取自 tools/device_probe.py 的漏网清单（器件确认是 SD/TF 卡座或 eMMC 的网）：
    # SDC0_CLK / SDC2_D1 是全志、瑞芯微一类 SoC 的控制器命名，SD_DATA0 / SD_CS 也常见。
    Klass("SDIO_EMMC",
          r"SDIO|EMMC|(^|_)SDC\d?_?(CLK|CMD|D\d|DATA\d)"
          r"|(^|_)SD_?(CLK|CMD|CS|D\d|DATA\d)|MMC\d?_", se=50,
          control=CONDITIONAL, priority=42,
          note="SDIO/eMMC/TF 卡单端 50Ω，高速档才控"),
    Klass("QSPI", r"QSPI|OSPI|(^|_)SPI[_]?(IO|SD)\d", se=50, control=CONDITIONAL, priority=43,
          note="Quad/Octal SPI，高频长线才控"),
    Klass("SPI", r"(^|_)(MOSI|MISO|SCK|SCLK|NSS|SPI)", se=50, control=CONDITIONAL, priority=44,
          note="仅长线/高速时做 50Ω，短线一般不控"),
    Klass("I2S", r"(^|_)(I2S|LRCK|LRCLK|BCLK|SDIN|SDOUT|MCLK)", se=50,
          control=CONDITIONAL, priority=45,
          note="长线时 50Ω"),

    # ---- 现场总线 ----
    Klass("CAN", r"CAN_?FD|CAN[_]?[HL]($|_)|(^|_)CAN_", diff=120, control=CONTROLLED, priority=46,
          note="CAN / CAN-FD 总线 120Ω"),
    Klass("RS485", r"RS?485|(^|_)485_?[AB]($|_)", diff=120, control=CONTROLLED, priority=47,
          note="RS-485 120Ω"),
    Klass("LIN", r"(^|_)LIN(BUS)?\d?($|_)(?!E)", control=UNCONTROLLED, priority=48,
          note="LIN 单线低速，不控。注意语料里 L_LIN/R_LIN 是声道、PWM_LIN 是线性调光，"
               "靠前缀区分不开的已归到这里，判读时按 uncontrolled 处理即可"),
    Klass("FLEXRAY", r"FLEXRAY|(^|_)FLEXRAY_?(BP|BM|[AB])($|_)", diff=100,
          control=CONTROLLED, priority=49,
          note="FlexRay 差分；裸 FR_A/FR_B 已移除，语料里那是别的东西（FRB）"),

    # ---- 明确不控：这些是基线的主体 ----
    Klass("I2C", r"(^|_)(SDA|SCL)\d?($|_)|I2C|PMBUS|SMBUS",
          control=UNCONTROLLED, priority=5,
          note="开漏低速，不做阻抗控制。SDA/SCL 语义唯一，必须排在所有接口类之前：SPI_SDA 是 I2C，HDMITX_SDA 是 HDMI 的 DDC 通道"),
    Klass("UART", r"(^|_)(TXD|RXD|UART|RTS|CTS)\d?($|_)", control=UNCONTROLLED, priority=61,
          note="串口低速，不控"),
    Klass("DEBUG", r"SWDIO|SWCLK|JTAG|(^|_)(TCK|TMS|TDI|TDO|TRST)($|_)",
          control=UNCONTROLLED, priority=62,
          note="调试口，不控"),
    Klass("CLOCK_XTAL", r"XTAL|(^|_)OSC\d*(_?(IN|OUT))?($|_)|(^|_)X[12]($|_)",
          control=UNCONTROLLED, priority=39,
          note="晶振引脚，不控阻抗（走线要短，但那不是阻抗约束）"),
    Klass("AUDIO", r"(^|_)(MIC|SPK|SPEAKER|HP|HPOUT|LINEIN|LINEOUT|AUDIO)"
                   r"[_]?\d*[_]?[PN+\-]?($|_)",
          control=UNCONTROLLED, priority=36,
          note="模拟音频，不控阻抗。必须早于 ADC/DAC：MIC_ADC_IN、ADC_MIC1P 这类是麦克风模拟链路，不是高速转换器接口"),
]
CLASSES.sort(key=lambda k: k.priority)
BY_NAME = {k.name: k for k in CLASSES}


def classify(net: str):
    if not net or net.startswith("$") or EXCLUDE.search(net):
        return None
    for k in CLASSES:
        if k.rx.search(net):
            return k
    return None


# 明确"不控阻抗"的指示类网络，跟 UNCONTROLLED 类别一起构成基线。
BASELINE_RE = re.compile(
    r"(^|_)(LED|KEY|BTN|BUTTON|BUZZ|BEEP|RELAY|FAN|MOTOR|VIB|SERVO)\d*($|_)"
    r"|(^|_)(GPIO|IO)\d+($|_)"
    r"|^P[A-HJ-NP-Z]\d{1,2}($|_)"
    # 审计补充：这些在未认领里板次很高（CS 501、DTR 441、CLK 396、BOOT 370），
    # 全是通用低速控制线，属于基线而不是「没人认领」。
    r"|^(CS|CE|CLK|DC|DTR|DSR|RI|DCD|BOOT\d?|NC|TP\d*|ENC\w*|WP|HOLD)$",
    re.I)


def is_baseline(net: str) -> bool:
    """这条网是否可以当「没人控阻抗」的对照。"""
    if not net or EXCLUDE.search(net):
        return False
    k = classify(net)
    if k is not None:
        return k.control == UNCONTROLLED
    return bool(BASELINE_RE.search(net))


# ---------------------------------------------------------------- 上下文消歧

# 有三种网名单看自己判不出来，只能借同一块板上的其他网名。审计里它们的板次都不小，
# 硬判会把整类的中位值带偏，所以宁可标成 AMBIGUOUS 从统计里排除，也不要猜。
_DP_CONTEXT = re.compile(r"(^|_)(DP_?(LANE|ML|AUX)|DPTX|DPRX|DISPLAYPORT)", re.I)
_ETH_CONTEXT = re.compile(r"(^|_)(MDI|TRD|ETH|PHY|RJ45|MAGJACK|LAN\d?|GMAC)", re.I)
_BARE_DP = re.compile(r"^D[PM]$", re.I)
_BARE_TXRX = re.compile(r"^[TR]X\d?[PNM]$|^[TR]X\d?[+\-]$", re.I)

AMBIGUOUS = "AMBIGUOUS"


def classify_in_board(net: str, board_nets, device_hint=None) -> tuple[str | None, str]:
    """返回 (类别名, 判据)。判据为 'device' = 器件引脚名认定，'name' = 网名自证，
    'context' = 靠同板佐证，'ambiguous' = 判不了（调用方应当排除，而不是塞进某一类）。

    device_hint 是 tools/device_probe.py --map 产出的 {网名: 类别}，来自**器件引脚名**
    而不是网名。引脚名由元件库带出，比设计者随手起的网名可靠得多：在 76151 个网名上
    实测，纯网名正则对器件确认过的接口网只有 19–53% 的召回。所以它优先于一切网名规则。
    """
    if not net or net.startswith("$") or EXCLUDE.search(net):
        return None, "excluded"

    if device_hint:
        cls = device_hint.get(net)
        if cls:
            return cls, "device"

    # 裸 DP/DM：绝大多数是 USB2 的 D+/D-，但 DisplayPort 也用 DP。
    if _BARE_DP.match(net):
        if any(_DP_CONTEXT.search(n) for n in board_nets):
            return AMBIGUOUS, "ambiguous"     # 同板两种 DP 并存，谁都不算
        return "USB2", "context"

    # 裸 TXP/TXN/RX+/RX-：可能是以太网 MDI，也可能是任何别的差分（LVDS、串行器）。
    if _BARE_TXRX.match(net):
        if any(_ETH_CONTEXT.search(n) for n in board_nets):
            return "ETHERNET", "context"
        return AMBIGUOUS, "ambiguous"

    k = classify(net)
    return (k.name if k else None), "name"


if __name__ == "__main__":
    n_ctl = sum(1 for k in CLASSES if k.control == CONTROLLED)
    n_cond = sum(1 for k in CLASSES if k.control == CONDITIONAL)
    n_unc = sum(1 for k in CLASSES if k.control == UNCONTROLLED)
    print(f"类别 {len(CLASSES)}：controlled {n_ctl} / conditional {n_cond} / uncontrolled {n_unc}\n")
    print(f"{'类别':<16}{'受控性':<14}{'单端':>6}{'差分':>6}  说明")
    for k in CLASSES:
        print(f"{k.name:<16}{k.control:<14}{str(k.se or '-'):>6}{str(k.diff or '-'):>6}  {k.note}")
    print("\n差分配对写法自检：")
    for probe in ("USB_DP", "D+", "HDMI_TX0_P", "NVL2T2+", "PCIE_RX0-",
                  "VCC_P", "PWM1P", "OUTH", "COMP"):
        print(f"  {probe:<14} -> {pair_partner(probe) or '（不视为差分正极）'}")
