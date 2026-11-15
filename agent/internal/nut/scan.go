package nut

import (
	"errors"
	"net"
)

// SNMP holds SNMP scan settings. Passwords are only used for the scan and written into ups.conf on apply.
type SNMP struct {
	Start        string `json:"start"`
	End          string `json:"end"`
	Version      string `json:"version"`
	Community    string `json:"community,omitempty"`
	SecLevel     string `json:"secLevel,omitempty"`
	SecName      string `json:"secName,omitempty"`
	AuthProtocol string `json:"authProtocol,omitempty"`
	AuthPassword string `json:"authPassword,omitempty"`
	PrivProtocol string `json:"privProtocol,omitempty"`
	PrivPassword string `json:"privPassword,omitempty"`
}

// ScanRequest is the nut_scan command.
type ScanRequest struct {
	USB  bool  `json:"usb"`
	SNMP *SNMP `json:"snmp,omitempty"`
}

// Device is one UPS found by nut-scanner.
type Device struct {
	Driver    string            `json:"driver"`
	Port      string            `json:"port"`
	Vendor    string            `json:"vendor,omitempty"`
	Product   string            `json:"product,omitempty"`
	Serial    string            `json:"serial,omitempty"`
	VendorID  string            `json:"vendorid,omitempty"`
	ProductID string            `json:"productid,omitempty"`
	Bus       string            `json:"bus,omitempty"`
	Desc      string            `json:"desc,omitempty"`
	Extra     map[string]string `json:"extra,omitempty"`
}

var (
	levels        = map[string]bool{"noAuthNoPriv": true, "authNoPriv": true, "authPriv": true}
	authProtocols = map[string]bool{"MD5": true, "SHA": true, "SHA256": true, "SHA384": true, "SHA512": true}
	privProtocols = map[string]bool{"DES": true, "AES": true, "AES192": true, "AES256": true}
)

func ipv4(value string) bool {
	ip := net.ParseIP(value)
	return ip != nil && ip.To4() != nil
}

// Secrets are the passwords in a scan request, to mask in its output.
func (r ScanRequest) Secrets() []string {
	if r.SNMP == nil {
		return nil
	}
	return []string{r.SNMP.Community, r.SNMP.AuthPassword, r.SNMP.PrivPassword}
}

// Args builds the nut-scanner arguments. Every value is checked first, so nothing reaches the command line unchecked.
func (r ScanRequest) Args() ([]string, error) {
	var args []string
	if r.USB {
		args = append(args, "-U")
	}
	if s := r.SNMP; s != nil {
		if !ipv4(s.Start) || !ipv4(s.End) {
			return nil, errors.New("SNMP range must be two IPv4 addresses")
		}
		args = append(args, "-S", "-s", s.Start, "-e", s.End)
		switch s.Version {
		case "v1", "v2c":
			if s.Community != "" {
				if !confValuePattern.MatchString(s.Community) && !validSecret(s.Community) {
					return nil, errors.New("invalid SNMP community")
				}
				args = append(args, "-c", s.Community)
			}
		case "v3":
			if !levels[s.SecLevel] || !confValuePattern.MatchString(s.SecName) {
				return nil, errors.New("SNMPv3 needs a valid security level and user")
			}
			args = append(args, "-l", s.SecLevel, "-u", s.SecName)
			if s.SecLevel != "noAuthNoPriv" {
				if !authProtocols[s.AuthProtocol] || !validSecret(s.AuthPassword) {
					return nil, errors.New("SNMPv3 authentication needs a valid protocol and password")
				}
				args = append(args, "-w", s.AuthProtocol, "-W", s.AuthPassword)
			}
			if s.SecLevel == "authPriv" {
				if !privProtocols[s.PrivProtocol] || !validSecret(s.PrivPassword) {
					return nil, errors.New("SNMPv3 privacy needs a valid protocol and password")
				}
				args = append(args, "-x", s.PrivProtocol, "-X", s.PrivPassword)
			}
		default:
			return nil, errors.New("SNMP version must be v1, v2c or v3")
		}
	}
	if len(args) == 0 {
		return nil, errors.New("choose USB, SNMP or both")
	}
	return args, nil
}

// ParseScan reads nut-scanner's ups.conf style output. Passwords it echoes are left out.
func ParseScan(output string) []Device {
	var devices []Device
	for _, section := range ParseUpsConf(output) {
		d := Device{Driver: section.Driver, Port: section.Port, Desc: section.Desc, Extra: map[string]string{}}
		for key, value := range section.Extra {
			switch key {
			case "vendor":
				d.Vendor = value
			case "product":
				d.Product = value
			case "serial":
				d.Serial = value
				d.Extra[key] = value
			case "vendorid":
				d.VendorID = value
				d.Extra[key] = value
			case "productid":
				d.ProductID = value
				d.Extra[key] = value
			case "bus":
				d.Bus = value
			default:
				if allowedExtra[key] && !SecretKeys[key] {
					d.Extra[key] = value
				}
			}
		}
		if d.Driver != "" && d.Port != "" {
			devices = append(devices, d)
		}
	}
	return devices
}
